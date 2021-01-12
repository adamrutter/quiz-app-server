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

interface ApiResponseQuestion {
  category: string
  type: string
  difficulty: string
  question: string
  correct_answer: string
  incorrect_answers: Array<string>
}

interface ProcessedQuestion {
  category: string
  type: string
  difficulty: string
  question: string
  correct_answer: string
  incorrect_answers: Array<string>
  number: number
  randomised_answers: Array<string> | undefined
}

interface UserScore {
  user: string
  score: string
}

/**
 * Returns a promise that resolves after the given timeout.
 * @param timeout
 */
const asyncTimeout = (timeout: number) => {
  return new Promise(resolve => setTimeout(resolve, timeout))
}

/**
 * Process the given questions into the format we want. Adds a randomised answer
 * array, and a question number.
 * @param questions
 */
const processQuestions = (
  questions: Array<ApiResponseQuestion>
): Array<ProcessedQuestion> => {
  const processed = questions.map(
    (question: ApiResponseQuestion, index: number) => {
      const randomisedAnswers = shuffle([
        ...question.incorrect_answers,
        question.correct_answer
      ])

      return {
        ...question,
        number: index + 1,
        randomised_answers: randomisedAnswers
      }
    }
  )

  return processed
}

/**
 * Get questions from Open Trivia DB. Adds a question number and an array of the randomised answers.
 * @param options An object consisting of options used by Open Trivia DB (see https://opentdb.com/api_config.php).
 */
export const getQuestions = async (
  options: QuizOptions
): Promise<Array<ProcessedQuestion>> => {
  try {
    const params = Object.entries(options)
      .filter(([key, value]) => value !== "Random")
      .map(([key, value]) => `${key}=${value}`)
      .join("&")
    const apiQuery = `https://opentdb.com/api.php?${params}`

    const {
      data: { results: questions }
    } = await axios.get(apiQuery)

    return processQuestions(questions)
  } catch (err) {
    throw new Error(err)
  }
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
const checkAnswer = (
  clientAnswer: string,
  question: ApiResponseQuestion
): boolean => {
  if (clientAnswer === question.correct_answer) {
    return true
  } else {
    return false
  }
}

/**
 * Update the user's quiz score.
 * @param userId The user ID provided by the client.
 * @param quizId The ID provided by the client.
 * @param score The amount to adjust the score by.
 * @param redis A Redis client.
 */
const updateQuizScore = async (
  userId: string,
  quizId: string,
  score: number,
  redis: Redis
): Promise<void> => {
  await redis.hincrby(`score:${quizId}`, userId, score)
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
export const allUsersReady = async (
  io: SocketIoServer,
  redis: Redis,
  partyId: string
): Promise<void> => {
  const usersReady: Array<string> = []

  io.to(partyId).emit("ready-prompt")

  const listenForReady = async (
    socket: Socket,
    resolve: (value: void | PromiseLike<void>) => void
  ) => {
    const allUsers = await redis.smembers(`${partyId}:members`)

    socket.once("user-ready", async ({ userId, partyId }) => {
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
  }

  return new Promise(resolve => {
    io.in(partyId).sockets.sockets.forEach(socket =>
      listenForReady(socket, resolve)
    )
  })
}

/**
 * Send a question to the client.
 */
const sendQuestion = (
  question: ProcessedQuestion,
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
      eventEmitter.emit(`all-answers-received-${quizId}-${questionNumber}`)
    }
  }

  eventEmitter.on(`answer-received-${quizId}-${questionNumber}`, listener)
}

/**
 * Returns a promise that resolves when all clients have provided an answer.
 * @param quizId
 * @param questionNumber
 * @param redis
 * @param io
 */
const allAnswersReceived = (
  quizId: string,
  questionNumber: number,
  redis: Redis,
  io: SocketIoServer
) => {
  listenForAllAnswers(redis, quizId, questionNumber)

  return new Promise<void>(resolve => {
    eventEmitter.once(
      `all-answers-received-${quizId}-${questionNumber}`,
      () => {
        // Remove event listeners for this quiz/question combo
        eventEmitter.removeAllListeners(
          `answer-received-${quizId}-${questionNumber}`
        )
        io.removeAllListeners(`answer-${quizId}-${questionNumber}`)
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
const setupAnswerHandling = (
  question: ProcessedQuestion,
  partyId: string,
  io: SocketIoServer,
  redis: Redis,
  quizId: string,
  questionNumber: number
) => {
  const answerHandler = (answer: string, partyId: string, userId: string) => {
    eventEmitter.emit(
      `answer-received-${quizId}-${question.number}`,
      partyId,
      quizId
    )

    const answerCorrect = checkAnswer(answer, question)
    if (answerCorrect) {
      updateQuizScore(userId, quizId, 1, redis)
    }
  }

  // Set up a socket.io listener for each client
  io.in(partyId).sockets.sockets.forEach(async socket => {
    socket.once(`answer-${quizId}-${questionNumber}`, answerHandler)
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
    timer(10000, io, `timer-update-${quizId}-${questionNumber}`, partyId),
    allAnswersReceived(quizId, questionNumber, redis, io)
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
 * Send the total amount of questions to the client.
 * @param amountOfQuestions The total amount of questions.
 * @param io The socket.io server.
 * @param partyId The party ID from the client.
 */
const sendAmountOfQuestions = (
  amountOfQuestions: number,
  io: SocketIoServer,
  partyId: string
): void => {
  io.in(partyId).emit("amount-of-questions", amountOfQuestions)
}

const generateScorecard = async (
  quizId: string,
  partyId: string,
  redis: Redis
): Promise<Array<UserScore>> => {
  const displayNames = await redis.hgetall(`${partyId}:display-names`)
  const scores = await redis.hgetall(`score:${quizId}`)

  const scorecard = Object.entries(scores).map(([userId, score]) => {
    const name = displayNames[userId]
    return { user: name, score }
  })

  return new Promise(resolve => {
    resolve(scorecard)
  })
}

const sendScorecard = async (
  quizId: string,
  partyId: string,
  redis: Redis,
  io: SocketIoServer
): Promise<void> => {
  const scorecard = await generateScorecard(quizId, partyId, redis)
  io.in(partyId).emit("updated-scorecard", scorecard)
}

/**
 * Steps to complete before the question.
 * @param quizId
 * @param partyId
 * @param redis
 * @param io
 */
const preQuestionProcedure = async (
  quizId: string,
  partyId: string,
  redis: Redis,
  io: SocketIoServer
) => {
  await sendScorecard(quizId, partyId, redis, io)
}

/**
 * Run procedure for sending question/handling answer(s).
 * @param question
 * @param partyId
 * @param socket
 * @param redis
 * @param io
 * @param quizId
 */
const runQuestion = async (
  question: ProcessedQuestion,
  partyId: string,
  socket: Socket,
  redis: Redis,
  io: SocketIoServer,
  quizId: string
) => {
  sendQuestion(question, partyId, socket, io)
  setupAnswerHandling(question, partyId, io, redis, quizId, question.number)
  await questionResolve(io, redis, partyId, quizId, question.number)

  const correctAnswerIndex = question.randomised_answers?.findIndex(
    el => el === question.correct_answer
  )
  sendCorrectAnswerIndex(correctAnswerIndex, partyId, io)
}

/**
 * Steps to complete after question completion.
 * @param io
 * @param partyId
 * @param resolve
 */
const postQuestionProcedure = async (
  io: SocketIoServer,
  partyId: string,
  quizId: string,
  redis: Redis
) => {
  sendScorecard(quizId, partyId, redis, io)

  await asyncTimeout(1500)
  io.in(partyId).emit("finish-question")
}

/**
 * Set up a scoreboard for this quiz, initialising all scores to 0.
 * @param quizId
 * @param partyId
 * @param redis
 */
const setupQuizScoresHash = async (
  quizId: string,
  partyId: string,
  redis: Redis
): Promise<void> => {
  const users = await redis.smembers(`${partyId}:members`)
  users.forEach(user => redis.hset(`score:${quizId}`, user, 0))
}

/**
 * Run the quiz. Returns a promise when all questions have been looped.
 * @param questions An array of questions.
 * @param socket The socket used to communicate with the client.
 * @param redis A Redis client.
 */
export const quiz = async (
  questions: Array<ProcessedQuestion>,
  partyId: string,
  socket: Socket,
  redis: Redis,
  io: SocketIoServer,
  quizId: string
): Promise<void> => {
  // Send amount of questions to client
  sendAmountOfQuestions(questions.length, io, partyId)

  // Set up a scoreboard
  setupQuizScoresHash(quizId, partyId, redis)

  // Loop through the given questions sequentially
  for await (const question of questions) {
    await preQuestionProcedure(quizId, partyId, redis, io)
    await runQuestion(question, partyId, socket, redis, io, quizId)
    await postQuestionProcedure(io, partyId, quizId, redis)
  }
}
