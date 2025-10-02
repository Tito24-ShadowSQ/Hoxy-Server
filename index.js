#!/usr/bin/env node

import http from "http"
import https from "https"
import fs from "fs"
import path from "path"
import readline from "readline"
import chalk from "chalk"
import stripAnsi from "strip-ansi"
import ip from "ip"
import { WebSocketServer } from "ws"
import url from "url"
import open from "open"
import selfsigned from "selfsigned"

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
function ask(question) { 
  return new Promise(resolve => rl.question(chalk.cyan(question), answer => resolve(answer.trim()))) 
}

const argv = process.argv.slice(2)
const args = Object.fromEntries(argv.flatMap((v, i) => 
  v.startsWith("-") ? [[v.replace(/^-+/, ""), argv[i+1] && !argv[i+1].startsWith("-") ? argv[i+1] : true]] : []
))

function colorizeURL(fullURL) {
  const match = fullURL.match(/(https?:\/\/)(.+):(\d+)/)
  if (!match) return chalk.whiteBright(fullURL)
  const [_, proto, host, port] = match
  return chalk.whiteBright(proto) + chalk.yellowBright(host) + chalk.yellowBright(`:${port}`)
}

function printBanner(lines) {
  const padding = 2
  const coloredLines = lines.map(l => {
    if (l.startsWith("- ")) {
      const parts = l.slice(2).split(" : ")
      const dash = chalk.cyanBright("-")
      const label = chalk.whiteBright(parts[0])
      const urlText = parts[1] ? colorizeURL(parts[1]) : ""
      return `${dash} ${label} : ${urlText}`
    } else {
      return chalk.greenBright(l)
    }
  })

  const maxLength = Math.max(...coloredLines.map(l => stripAnsi(l).length)) + padding * 2
  const top = chalk.whiteBright("╔" + "═".repeat(maxLength) + "╗")
  const bottom = chalk.whiteBright("╚" + "═".repeat(maxLength) + "╝")

  console.log(top)
  coloredLines.forEach(line => {
    const spaces = maxLength - stripAnsi(line).length
    const left = Math.floor(spaces / 2)
    const right = spaces - left
    console.log(chalk.whiteBright("║") + " ".repeat(left) + line + " ".repeat(right) + chalk.whiteBright("║"))
  })
  console.log(bottom)
}

function printHelp() {
  printBanner([
    chalk.blueBright("Hoxy - Static HTTP Server "),
    chalk.whiteBright("Usage: npx hoxy"),
    "",
    chalk.cyan("-help") + "              " + chalk.whiteBright("Show this help menu"),
    chalk.cyan("-port <number>") + "     " + chalk.whiteBright("Set port (default = 3000)"),
    chalk.cyan("-http") + "              " + chalk.whiteBright("Force HTTP"),
    chalk.cyan("-https") + "             " + chalk.whiteBright("Force HTTPS (selfsigned)"),
    chalk.cyan("-live-reload enable") + "   " + chalk.whiteBright("Enable live reload"),
    chalk.cyan("-cors enable") + "       " + chalk.whiteBright("Enable CORS headers"),
    chalk.cyan("-spa enable") + "        " + chalk.whiteBright("Enable SPA fallback"),
    "",
    chalk.greenBright("Example:"),
    chalk.whiteBright("npx hoxy -port 3000 -live-reload enable -https -cors enable -spa disable")
  ])
}

async function start() {
  if (args.help) {
    printHelp()
    process.exit(0)
  }

  let port = args.port || await ask("Enter port: ")
  port = parseInt(port) || 3000

  let protocol = args.https ? "https" : args.http ? "http" : await ask("HTTP or HTTPS: ")
  protocol = (protocol || "http").toLowerCase()

  let enableReload = args["live-reload"] === "enable" || (await ask("Use live reload (y/n): ")) === "y"
  let enableCORS = args.cors === "enable" || (await ask("Use CORS (y/n): ")) === "y"
  let enableSPA = args.spa === "enable" || (await ask("Use SPA fallback (y/n): ")) === "y"

  rl.close()
  const root = process.cwd()

  function logRequest(method, pathname, status, size, startTime, ext) {
    const time = Date.now() - startTime
    const colorStatus = status >= 500 ? chalk.redBright
                      : status >= 400 ? chalk.yellowBright
                      : status >= 300 ? chalk.cyanBright
                      : chalk.greenBright
    let colorMethod = chalk.blueBright
    let colorPath = chalk.whiteBright
    if (ext === ".html") colorPath = chalk.greenBright
    else if (ext === ".js") colorPath = chalk.yellowBright
    else if (ext === ".css") colorPath = chalk.cyanBright
    console.log(
      `${colorMethod(method.padEnd(4))} ${colorPath(pathname.padEnd(30))} ${colorStatus(status)} ${chalk.white(size.toString().padStart(6))}b ${chalk.gray(`${time}ms`)}`
    )
  }

  function handler(req, res) {
  const startTime = Date.now()
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname
  let filepath = path.join(root, pathname)

  fs.stat(filepath, (err, stats) => {
    if (!err && stats.isFile()) {
      serveFile(filepath, res, req.method, pathname, stats.size)
    } else if (!err && stats.isDirectory()) {
      const indexFile = path.join(filepath, "index.html")
      if (fs.existsSync(indexFile)) {
        serveFile(indexFile, res, req.method, pathname === "/" ? "/index.html" : pathname + "/index.html", fs.statSync(indexFile).size)
      } else {
        const content = "<h1>Directory</h1><ul>" + fs.readdirSync(filepath).map(f => `<li><a href="${path.join(pathname,f)}">${f}</a></li>`).join("") + "</ul>"
        res.writeHead(200, { "Content-Type": "text/html" })
        res.end(content)
        logRequest(req.method, pathname, 200, content.length, 0, ".html")
      }
    } else if (enableSPA && fs.existsSync(path.join(root, "index.html"))) {
      const spaFile = path.join(root, "index.html")
      serveFile(spaFile, res, req.method, "/index.html", fs.statSync(spaFile).size)
    } else {
      res.writeHead(404)
      res.end(chalk.redBright("404 Not Found"))
      logRequest(req.method, pathname, 404, 0, 0, "")
    }
  })
}

function serveFile(filepath, res, method, pathname, size) {
  const startTime = Date.now()
  let ext = path.extname(filepath).toLowerCase()
  let type = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" }[ext] || "application/octet-stream"
  let data = fs.readFileSync(filepath, "utf-8")
  
  if (enableReload && ext === ".html") {
    data = data.replace("</body>", `<script>
      const ws = new WebSocket((location.protocol==="https:"?"wss://":"ws://")+location.host);
      ws.onmessage = () => location.reload();
    </script></body>`)
  }

  if (enableCORS) res.setHeader("Access-Control-Allow-Origin", "*")
  res.writeHead(200, { "Content-Type": type })
  res.end(data)

  logRequest(method, pathname, 200, size, startTime, ext)
}


  let server
  if (protocol === "https") {
    const attrs = [{ name: "commonName", value: "localhost" }]
    const pems = selfsigned.generate(attrs, { days: 365 })
    server = https.createServer({ key: pems.private, cert: pems.cert }, handler)
  } else {
    server = http.createServer(handler)
  }

  if (enableReload) {
    const wss = new WebSocketServer({ server })
    fs.watch(root, { recursive: true }, () => {
      wss.clients.forEach(c => c.send("reload"))
    })
  }

  server.listen(port, () => {
    const local = `${protocol}://localhost:${port}`
    const network = `${protocol}://${ip.address()}:${port}`

    printBanner([
      "Server Launched",
      `- Local : ${local}`,
      `- Network : ${network}`,
      "- Quit CMD to stop the Server"
    ])

    open(local)
  })
}

start()
