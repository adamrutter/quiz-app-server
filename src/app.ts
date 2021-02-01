import { setupRedis } from "./redis"
import { setupSocketIO } from "./socket"
import express from "express"
import http from "http"

require("dotenv").config() // eslint-disable-line @typescript-eslint/no-var-requires

const port = process.env.PORT || 5000
const app = express()
const server = new http.Server(app)

// Allow cross origin request
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*")
  res.header("Access-Control-Allow-Headers", "X-Requested-With")
  next()
})

app.get("/", (req, res) => res.send("Server is listening..."))

// Setup
const redis = setupRedis()
app.set("redis", redis)

setupSocketIO(server, app)

// Start server
server.listen(port, () => {
  console.log(`Server listening on port ${port}`)
})
