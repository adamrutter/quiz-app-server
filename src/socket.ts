import { Express } from "express"
import { checkAnswer, getQuestions, sendQuestion, questionTimer } from "./quiz"
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
      redis.hset(`party:${partyId}`)

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

      const partyMembers = await redis.lrange(`${partyId}:members`, 0, -1)

      // Check if user is already in this party
      if (partyMembers.length === 0 || !partyMembers.includes(userId)) {
        joinParty(partyId, userId, redis)
      }
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
          await new Promise<void>(resolve => {
            // Send question, resolve either on timeout or receiving an answer
            sendQuestion(questions[i], socket, questionTimer, 10000).then(() =>
              resolve()
            )
            socket.on(
              "answer",
              (answer: string, partyId: string, userId: string) => {
                checkAnswer(answer, questions[i])
                resolve()
              }
            )
          })
        }
      })
    })
  })
}
