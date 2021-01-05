import { Express } from "express"
import { getQuestions, quiz, readyPrompt } from "./quiz"
import { Redis } from "ioredis"
import { Server as HttpServer } from "http"
import { Server as SocketIoServer, Socket } from "socket.io"
import { v4 as uuidv4 } from "uuid"
import { joinParty } from "./party"

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
      socket.emit("new-party-id", partyId)
    })

    // Request a user id
    socket.on("request-user-id", () => {
      const userId = uuidv4()
      socket.emit("new-user-id", userId)
    })

    // Join an already existing party
    socket.on("join-party", async (partyId: string, userId: string) => {
      socket.join(partyId)
      joinParty(partyId, userId, redis, socket)
    })

    // Pull questions from Open Trivia DB and send to the client
    socket.on("start-quiz", arg => {
      const {
        partyId,
        options: { amount, category, difficulty, type }
      } = arg

      readyPrompt(socket, io, redis, partyId).then(() => {
        const quizId = uuidv4()
        io.to(partyId).emit("new-quiz-id", quizId)

        const options = {
          amount: amount || "",
          category: category || "",
          difficulty: difficulty || "",
          type: type || ""
        }

        getQuestions(options)
          .then(questions =>
            quiz(questions, partyId, socket, redis, io, quizId)
          )
          .then(() => console.log("finished quiz"))
      })
    })
  })
}
