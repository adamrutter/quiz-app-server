import { Express } from "express"
import { getQuestions, sendQuestion, questionTimer } from "./quiz"
import { Redis } from "ioredis"
import { Server as HttpServer } from "http"
import { Server as SocketIoServer, Socket } from "socket.io"
import { v4 as uuidv4 } from "uuid"

export const setupSocketIO = (server: HttpServer, app: Express): void => {
  const io = new SocketIoServer(server, {
    // Allow cross origin request from client sub-domain
    cors: {
      origin: process.env.CLIENT_URL
    }
  })

  const redis: Redis = app.get("redis")

  io.on("connect", (socket: Socket) => {
    // Request the creation of a new party
    // Emit back to the client the id of the new party
    socket.on("request-new-party", () => {
      const partyId = uuidv4()
      redis.hset(`party:${partyId}`)

      socket.emit("new-party-id", partyId)
    })

    // Join an already existing party
    socket.on("join-party", (id: string) => {
      socket.join(id)
    })

    // Pull questions from Open Trivia DB and send to the client
    socket.on("start-quiz", options => {
      const { amount, category, difficulty, type } = options

      getQuestions({
        amount: amount || "",
        category: category || "",
        difficulty: difficulty || "",
        type: type || ""
      }).then(async questions => {
        for (let i = 0; i < questions.length; i++) {
          await sendQuestion(questions[i], socket, questionTimer, 10000)
        }
      })
    })
  })
}
