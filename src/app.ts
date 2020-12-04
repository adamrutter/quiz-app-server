import { setupSocketIO } from "./socket"
import express from "express"
import http from "http"

require("dotenv").config() // eslint-disable-line @typescript-eslint/no-var-requires

const port = process.env.PORT || 5000
const app = express()
const server = new http.Server(app)

// Allow cross origin request from client sub-domain
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", process.env.CLIENT_URL)
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept"
  )
  next()
})

// Setup socket.io
setupSocketIO(server)

// Start server
server.listen(port, () => {
  console.log(`Server listening on port ${port}`)
})
