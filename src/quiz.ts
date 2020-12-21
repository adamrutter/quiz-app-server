import { clearInterval } from "timers"
import { Redis } from "ioredis"
import { Socket, Server as SocketIoServer } from "socket.io"
import axios from "axios"
import shuffle from "shuffle-array"

export interface QuizOptions {
  amount?: string
  category?: string
  difficulty?: string
  type?: string
}

interface Question {
  category: string
  type: string
  difficulty: string
  question: string
  correct_answer: string
  incorrect_answers: Array<string>
  number?: number | undefined
  randomised_answers?: Array<string> | undefined
}

/**
 * Get questions from Open Trivia DB. Adds a question number and an array of the randomised answers.
 * @param options An object consisting of options used by Open Trivia DB (see https://opentdb.com/api_config.php).
 */
export const getQuestions = (
  options: QuizOptions
): Promise<Array<Question>> => {
  return new Promise((resolve, reject) => {
    const params = Object.entries(options)
      .map(([key, value]) => `${key}=${value}`)
      .join("&")

    axios
      .get(`https://opentdb.com/api.php?${params}`)
      .then(res => {
        const data = res.data.results.map(
          (question: Question, index: number) => {
            const randomisedAnswers = shuffle([
              ...question.incorrect_answers,
              question.correct_answer
            ])
            return {
              ...question,
              number: index,
              randomised_answers: randomisedAnswers
            }
          }
        )
        return data
      })
      .then(data => resolve(data))
      .catch(err => reject(err))
  })
}

/**
 * Start a timer, and send updates to the client. Returns a promise.
 * @param timeout The timeout for the timer.
 * @param socket The socket used to send updates to the client.
 */
const questionTimer = (timeout: number, socket: Socket): Promise<void> => {
  return new Promise<void>(resolve => {
    let secondsLeft = timeout / 1000
    socket.emit("timer-update", secondsLeft)

    const timer = setInterval(() => {
      secondsLeft--

      // Stop timer at 0
      if (secondsLeft === 0) {
        clearInterval(timer)
        resolve()
      }

      socket.emit("timer-update", secondsLeft)
    }, 1000)

    // Stop timer once an answer has been received from client
    socket.once("answer", () => {
      clearInterval(timer)
    })
  })
}

/**
 * Send a question to the client. Returns a promise.
 * @param question The question to send.
 * @param socket The socket used to send the question.
 * @param timer An optional timer function to delay returning the promise.
 * @param timeout The timeout for the optional timer function.
 */
const sendQuestion = (
  question: Question,
  socket: Socket,
  timer?: (timeout: number, socket: Socket) => Promise<void> | undefined,
  timeout?: number | undefined
): Promise<void> => {
  return new Promise<void>(resolve => {
    socket.emit("new-question", {
      question: question.question,
      answers: question.randomised_answers,
      category: question.category,
      difficulty: question.difficulty,
      number: question.number
    })

    if (timer) {
      timer(timeout as number, socket)?.then(() => resolve())
    } else {
      resolve()
    }
  })
}

/**
 * Check answer. Returns true if correct, false if incorrect.
 * @param clientAnswer The answer provided by the client.
 * @param question The server-side question object.
 */
const checkAnswer = (clientAnswer: string, question: Question): boolean => {
  if (clientAnswer === question.correct_answer) {
    return true
  } else {
    return false
  }
}

/**
 * Update the user's party score.
 * @param userId The user ID provided by the client.
 * @param partyId The ID provided by the client.
 * @param score The amount to adjust the score by.
 * @param redis A Redis client.
 */
const updatePartyScore = (
  userId: string,
  partyId: string,
  score: number,
  redis: Redis
): Promise<void> => {
  return new Promise<void>(resolve => {
    redis.hincrby(`score:${partyId}`, userId, score).then(() => resolve())
  })
}

/**
 * Update the user's quiz score.
 * @param userId The user ID provided by the client.
 * @param quizId The ID provided by the client.
 * @param score The amount to adjust the score by.
 * @param redis A Redis client.
 */
const updateQuizScore = (
  userId: string,
  quizId: string,
  score: number,
  redis: Redis
): Promise<void> => {
  return new Promise<void>(resolve => {
    redis.hincrby(`score:${quizId}`, userId, score).then(() => resolve())
  })
}

/**
 * Handle receiving an answer from the client.
 * @param question The server-side question object.
 * @param socket The socket to communicate with the client.
 * @param redis A Redis client.
 */
const handleAnswer = (
  question: Question,
  socket: Socket,
  redis: Redis
): Promise<void> => {
  return new Promise(resolve => {
    socket.once(
      "answer",
      (answer: string, partyId: string, userId: string, quizId: string) => {
        if (checkAnswer(answer, question) === true) {
          updatePartyScore(userId, partyId, 1, redis)
          updateQuizScore(userId, quizId, 1, redis)
        }
        resolve()
      }
    )
  })
}

/**
 * Emit an event telling the client to display the ready prompt.
 *
 * Returns a promise that resolves when all users in the room have confirmed
 * they are ready.
 * @param socket The socket of the user who emitted the 'start-quiz' event.
 * @param io The socket.io server.
 * @param redis A Redis client.
 * @param partyId The party ID.
 */
export const readyPrompt = (
  socket: Socket,
  io: SocketIoServer,
  redis: Redis,
  partyId: string
): Promise<void> => {
  interface user {
    id: string
  }
  return new Promise(resolve => {
    const usersReady: Array<user> = []
    io.to(partyId).emit("ready-prompt")

    // Set up listeners on all sockets in the room
    io.in(partyId).sockets.sockets.forEach(socket => {
      socket.once("user-ready", async ({ userId, partyId }) => {
        const allUsers = await redis.smembers(`${partyId}:members`)

        !usersReady.includes(userId) && usersReady.push(userId)

        if (usersReady.length === allUsers.length) {
          io.to(partyId).emit("all-users-ready")
        resolve()
      } else {
          const percentUsersReady = (usersReady.length / allUsers.length) * 100
        socket.emit("these-users-ready", usersReady)
          socket.emit("percent-users-ready", percentUsersReady)
      }
    })
  })
  })
}

/**
 * Run the quiz. Returns a promise when all questions have been looped.
 * @param questions An array of questions.
 * @param socket The socket used to communicate with the client.
 * @param redis A Redis client.
 */
export const quiz = async (
  questions: Array<Question>,
  socket: Socket,
  redis: Redis
): Promise<void> => {
  // Loop through the given questions sequentially
  for (let i = 0; i < questions.length; i++) {
    await new Promise<void>(resolve => {
      // Send question, resolve either on question timeout...
      sendQuestion(questions[i], socket, questionTimer, 10000).then(() =>
        resolve()
      )
      // ... or resolve on receiving an answer
      handleAnswer(questions[i], socket, redis).then(() => resolve())
    })
  }
}
