import { clearInterval } from "timers"
import { EventEmitter } from "events"
import { Redis } from "ioredis"
import { Socket, Server as SocketIoServer } from "socket.io"
import axios from "axios"
import shuffle from "shuffle-array"

const eventEmitter = new EventEmitter()

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
      .filter(([key, value]) => value !== "Random")
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
 * Start a timer, and send updates to the client. Returns a promise on timeout.
 * @param timeout The timeout for the timer.
 * @param socket The socket used to send updates to the client.
 * @param event The event to emit to the client.
 */
const timer = (
  timeout: number,
  io: SocketIoServer,
  event: string,
  partyId: string
): Promise<void> => {
  return new Promise<void>(resolve => {
    let secondsLeft = timeout / 1000
    io.in(partyId).emit(event, secondsLeft)

    const time = setInterval(() => {
      secondsLeft--

      // Stop timer at 0
      if (secondsLeft === 0) {
        clearInterval(time)
        resolve()
      }

      io.in(partyId).emit(event, secondsLeft)
    }, 1000)
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
 * Send a question to the client.
 */
const sendQuestion = (
  question: Question,
  partyId: string,
  socket: Socket,
  io: SocketIoServer
) => {
  io.to(partyId).emit("new-question", {
    question: question.question,
    answers: question.randomised_answers,
    category: question.category,
    difficulty: question.difficulty,
    number: question.number
  })
}

/**
 * Emit an event when all clients have sent an answer.
 */
const listenForAllAnswers = (
  redis: Redis,
  quizId: string,
  questionNumber: number
) => {
  const listener = async (partyId: string) => {
    const numberOfAnswers = await redis.incr(
      `${quizId}:${questionNumber}:answers`
    )
        const allPartyMembers = await redis.smembers(`${partyId}:members`)
    const numberOfPartyMembers = allPartyMembers.length

    if (numberOfAnswers === numberOfPartyMembers) {
      eventEmitter.emit(`all-answers-received-${quizId}-${questionNumber + 1}`)
        }
      }

  eventEmitter.on(`answer-received-${quizId}-${questionNumber + 1}`, listener)
}

const allAnswersReceived = (
  quizId: string,
  questionNumber: number,
  redis: Redis
) => {
  listenForAllAnswers(redis, quizId, questionNumber)

  return new Promise<void>(resolve => {
    eventEmitter.once(
      `all-answers-received-${quizId}-${questionNumber + 1}`,
      () => {
        // Remove event listeners for this quiz/question combo
        eventEmitter.removeAllListeners(
          `answer-received-${quizId}-${questionNumber + 1}`
    )
        resolve()
      }
    )
  })
}

/**
 * Handle receiving an answer from a client.
 *
 * Updates the user's score if correct, and emits an event to notify node.js an
 * answer has been received.
 *
 */
const handleAnswer = (
  question: Question,
  partyId: string,
  io: SocketIoServer,
  redis: Redis
) => {
  const answerHandler = (
    answer: string,
    partyId: string,
    userId: string,
    quizId: string
  ) => {
    eventEmitter.emit(
      `answer-received-${quizId}-${question.number + 1}`,
      partyId,
      quizId
    )
        if (checkAnswer(answer, question) === true) {
          updateQuizScore(userId, quizId, 1, redis)
        }
      }

  // Set up a socket.io listener for each client
  io.in(partyId).sockets.sockets.forEach(async socket => {
    socket.once("answer", answerHandler)
  })
}

/**
 * Resolve conditions for the current question.
 * @param io
 * @param redis
 * @param partyId
 * @param quizId
 * @param questionNumber
 */
const questionResolve = async (
  io: SocketIoServer,
  redis: Redis,
  partyId: string,
  quizId: string,
  questionNumber: number
) => {
  await Promise.any([
    timer(10000, io, `timer-update-${quizId}-${questionNumber + 1}`, partyId),
    allAnswersReceived(quizId, questionNumber, redis)
  ])
}

/**
 * Send the correct answer's index from the answers array.
 * @param correctAnswerIndex The index of the correct answer in the answers array.
 * @param partyId
 * @param io
 */
const sendCorrectAnswerIndex = (
  correctAnswerIndex: number | undefined,
  partyId: string,
  io: SocketIoServer
) => {
  io.in(partyId).emit("correct-answer", correctAnswerIndex)
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
    await new Promise<void>(resolve => {})
  }
}
