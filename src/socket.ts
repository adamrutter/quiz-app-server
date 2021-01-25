import { emitErrorMessageToSocket } from "./util"
import { Express } from "express"
import { getQuestions, quiz, allUsersReady } from "./quiz"
import { Redis } from "ioredis"
import { Server as HttpServer } from "http"
import { Server as SocketIoServer, Socket } from "socket.io"
import { v4 as uuidv4 } from "uuid"
import {
  assignDisplayName,
  changeDisplayName,
  joinParty,
  removePartyMember,
  sendListOfPartyMembers,
  sendUserDisplayName
} from "./party"

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
      assignDisplayName(userId, partyId, redis)
        .then(() => sendUserDisplayName(userId, partyId, socket, redis))
        .then(() => sendListOfPartyMembers(partyId, redis, io))
    })

    // Pull questions from Open Trivia DB and send to the client
    socket.on("start-quiz", async arg => {
      const {
        partyId,
        options: { amount, category, difficulty, type }
      } = arg

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
        const quizId = uuidv4()
        io.to(partyId).emit("new-quiz-id", quizId)

        // Run the quiz, and await its finish
        await quiz(questions, partyId, socket, redis, io, quizId)
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
    socket.on("kick-party-member", async (userId: string, partyId: string) => {
      // Tell clients which user is being removed from the party
      io.in(partyId).emit("user-leaving-party", userId)

      await removePartyMember(userId, partyId, redis)
      sendListOfPartyMembers(partyId, redis, io)
    })

    // Emit to all clients when the party leader chooses a category
    socket.on(
      "party-leader-quiz-options",
      (options: Record<string, unknown>, partyId: string) => {
        io.in(partyId).emit("options-changed", options)
      }
    )
  })
}
