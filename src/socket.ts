import { config } from "./config"
import { customAlphabet } from "nanoid"
import { emitErrorMessageToSocket } from "./util"
import { Express } from "express"
import { getQuestions, quiz, allUsersReady } from "./quiz"
import { Redis } from "ioredis"
import { Server as HttpServer } from "http"
import { Server as SocketIoServer, Socket } from "socket.io"
import {
  assignDisplayName,
  changeDisplayName,
  doesPartyExist,
  getDisplayName,
  joinParty,
  removePartyMember,
  sendListOfPartyMembers,
  sendUserDisplayName
} from "./party"

const { nanoidAlphabet } = config
const nanoid = (length: number) => {
  const id = customAlphabet(nanoidAlphabet, length)
  return id()
}

export const setupSocketIO = (server: HttpServer, app: Express): void => {
  try {
    const io = new SocketIoServer(server, {
      // Allow cross origin request from client sub-domain
      cors: {
        origin: "*"
      }
    })

    const redis: Redis = app.get("redis")

    io.on("connect", (socket: Socket) => {
      // Request the creation of a new party
      socket.on("request-new-party", (userId: string) => {
        const partyId = nanoid(7)
        socket.join(partyId)
        joinParty(partyId, userId, redis, socket, io)
      })

      // Join an already existing party
      socket.on("join-party", async (partyId: string, userId: string) => {
        socket.join(partyId)
        joinParty(partyId, userId, redis, socket, io)
      })

      // Pull questions from Open Trivia DB and send to the client
      socket.on("start-quiz", async arg => {
        const {
          partyId,
          options: { amount, category, difficulty, type, time }
        } = arg
        const questionTimeout = parseInt(time) * 1000

        // Wait for all users to confirm they are ready
        await allUsersReady(io, redis, partyId)

        try {
          // Get questions using the given options
          const options = {
            amount: amount || "",
            category: category || "",
            difficulty: difficulty || "",
            type: type || ""
          }
          const questions = await getQuestions(options)

          // Send the ID for the new quiz to all clients
          const quizId = nanoid(10)
          io.to(partyId).emit("new-quiz-id", quizId)

          // Run the quiz, and await its finish
          await quiz(
            questions,
            partyId,
            socket,
            redis,
            io,
            quizId,
            questionTimeout
          )
        } catch (err) {
          emitErrorMessageToSocket(err.message, socket)
        }

        // Tell clients the quiz has finished
        io.to(partyId).emit("quiz-finished")
      })

      // Update a user's display name
      socket.on(
        "change-display-name",
        async (name: string, userId: string, partyId: string) => {
          await changeDisplayName(userId, name, partyId, redis)
          await sendUserDisplayName(userId, partyId, socket, redis)
          sendListOfPartyMembers(partyId, redis, io)
        }
      )

      // Send party members list to client
      socket.on("request-party-members", (partyId: string) => {
        sendListOfPartyMembers(partyId, redis, io)
      })

      // Remove a member from the party
      socket.on(
        "kick-party-member",
        async (userId: string, partyId: string) => {
          // Tell clients which user is being removed from the party
          const user = {
            id: userId,
            name: await getDisplayName(userId, partyId, redis)
          }
          io.in(partyId).emit("user-leaving-party", user)

          await removePartyMember(userId, partyId, redis)
          sendListOfPartyMembers(partyId, redis, io)
        }
      )

      // Emit to all clients when the party leader chooses a category
      socket.on(
        "party-leader-quiz-options",
        (options: Record<string, unknown>, partyId: string) => {
          io.in(partyId).emit("options-changed", options)
        }
      )

      // Verify whether the given party exists
      socket.on("does-party-exist", async (partyId: string) => {
        const exists = await doesPartyExist(partyId, redis)
        socket.emit("party-exists", exists)
      })
    })

    console.log("Socket.IO ready")
  } catch (err) {
    console.log(err)
  }
}
