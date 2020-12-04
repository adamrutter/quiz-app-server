import { Server as HttpServer } from "http"
import { Server as SocketIoServer, Socket } from "socket.io"

export const setupSocketIO = (server: HttpServer): void => {
  const io = new SocketIoServer(server, {
    // Allow cross origin request from client sub-domain
    cors: {
      origin: process.env.CLIENT_URL
    }
  })

  io.on("connect", (socket: Socket) => {
    socket.on("message", data => {
      io.emit("message", data)
    })
  })
}
