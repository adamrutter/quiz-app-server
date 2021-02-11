import { clearInterval } from "timers"
import { EventEmitter } from "events"
import { Redis } from "ioredis"
import { config } from "./config"
import { Socket, Server as SocketIoServer } from "socket.io"
import { User } from "./types"
import axios from "axios"
import shuffle from "shuffle-array"
import { getDisplayName } from "./party"

const { redisExpireTime } = config

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
  name: string
  id: string
  score: number
  answeredCorrectly?: boolean
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

    if (questions.length === 0) {
      throw new Error(
        "Could not find enough questions. Try changing the options you selected"
      )
    }

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
  partyId: string,
  quizId: string,
  questionNumber: number,
  eventEmitter: EventEmitter
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

    eventEmitter.once(
      `all-answers-received-${quizId}-${questionNumber}`,
      () => {
        clearInterval(time)
      }
    )
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
 * @param io The socket.io server.
 * @param redis A Redis client.
 * @param partyId The party ID.
 * @param eventEmitter
 */
export const allUsersReady = async (
  io: SocketIoServer,
  redis: Redis,
  partyId: string,
  eventEmitter: EventEmitter
): Promise<void> => {
  const party = io.in(partyId)
  const allUsers = await redis.smembers(`${partyId}:members`)
  const usersReady: User[] = []

  party.emit("ready-prompt")

  return new Promise(resolve => {
    const listener = async (user: { userId: string; partyId: string }) => {
      const name = await getDisplayName(user.userId, partyId, redis)
      usersReady.push({ id: user.userId, name })

      if (usersReady.length === allUsers.length) {
        party.emit("all-users-ready")
        eventEmitter.off(`${partyId}-user-ready`, listener)
        resolve()
      } else {
        const percentUsersReady = (usersReady.length / allUsers.length) * 100
        party.emit("percent-users-ready", percentUsersReady)
        party.emit("these-users-ready", usersReady)
      }
    }
    eventEmitter.on(`${partyId}-user-ready`, listener)
  })
}

/**
 * Send a question to the client.
 */
const sendQuestion = (
  question: ProcessedQuestion,
  partyId: string,
  io: SocketIoServer,
  timeLimit: number,
  total: number
) => {
  io.to(partyId).emit(
    "new-question",
    {
      question: question.question,
      answers: question.randomised_answers,
      category: question.category,
      difficulty: question.difficulty,
      number: question.number,
      total
    },
    timeLimit / 1000
  )
}

/**
 * Emit an event when all clients have sent an answer.
 */
const listenForAllAnswers = (
  redis: Redis,
  quizId: string,
  questionNumber: number,
  eventEmitter: EventEmitter
) => {
  const listener = async (partyId: string) => {
    const numberOfAnswers = await redis.incr(
      `${quizId}:${questionNumber}:answers`
    )
    redis.expire(`${quizId}:${questionNumber}:answers`, redisExpireTime)
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
 * @param eventEmitter
 */
const allAnswersReceived = (
  quizId: string,
  questionNumber: number,
  redis: Redis,
  io: SocketIoServer,
  eventEmitter: EventEmitter
) => {
  listenForAllAnswers(redis, quizId, questionNumber, eventEmitter)

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
 * Record the users who answered this question correctly.
 * @param quizId
 * @param userId
 * @param questionNumber
 * @param redis
 */
const recordCorrectUser = (
  quizId: string,
  userId: string,
  questionNumber: number,
  redis: Redis
) => {
  redis.lpush(`users-answered-correctly:${quizId}_${questionNumber}`, userId)
  redis.expire(
    `users-answered-correctly:${quizId}_${questionNumber}`,
    redisExpireTime
  )
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
  questionNumber: number,
  eventEmitter: EventEmitter
) => {
  const answerHandler = async (
    answer: string,
    partyId: string,
    userId: string
  ) => {
    eventEmitter.emit(
      `answer-received-${quizId}-${question.number}`,
      partyId,
      quizId
    )

    const answerCorrect = checkAnswer(answer, question)
    if (answerCorrect) {
      updateQuizScore(userId, quizId, 1, redis)
      recordCorrectUser(quizId, userId, question.number, redis)
    }

    const displayName = await redis.hget(`${partyId}:display-names`, userId)
    const users = await redis.hgetall(`${partyId}:display-names`)
    const numberOfUsers = Object.keys(users).length
    io.in(partyId).emit(
      "user-answered",
      { id: userId, name: displayName },
      numberOfUsers
    )
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
 * @param eventEmitter
 */
const questionResolve = async (
  io: SocketIoServer,
  redis: Redis,
  partyId: string,
  quizId: string,
  questionNumber: number,
  timeLimit: number,
  eventEmitter: EventEmitter
) => {
  await Promise.any([
    timer(
      timeLimit,
      io,
      `timer-update-${quizId}-${questionNumber}`,
      partyId,
      quizId,
      questionNumber,
      eventEmitter
    ),
    allAnswersReceived(quizId, questionNumber, redis, io, eventEmitter)
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

const generateScorecard = async (
  quizId: string,
  partyId: string,
  redis: Redis,
  questionNumber?: number
): Promise<Array<UserScore>> => {
  const displayNames = await redis.hgetall(`${partyId}:display-names`)
  const scores = await redis.hgetall(`score:${quizId}`)
  const correctUsers = await redis.lrange(
    `users-answered-correctly:${quizId}_${questionNumber}`,
    0,
    -1
  )

  const scorecard = Object.entries(scores).map(([userId, score]) => {
    const name = displayNames[userId]
    const answeredCorrectly = correctUsers.includes(userId) || undefined
    return { name, id: userId, score: parseInt(score), answeredCorrectly }
  })

  const orderedScorecard = scorecard.sort((a, b) => b.score - a.score)

  return orderedScorecard
}

const sendScorecard = async (
  quizId: string,
  partyId: string,
  redis: Redis,
  io: SocketIoServer,
  questionNumber?: number
): Promise<void> => {
  const scorecard = await generateScorecard(
    quizId,
    partyId,
    redis,
    questionNumber
  )
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
 * @param eventEmitter
 * @param total
 */
const runQuestion = async (
  question: ProcessedQuestion,
  partyId: string,
  redis: Redis,
  io: SocketIoServer,
  quizId: string,
  timeLimit: number,
  eventEmitter: EventEmitter,
  total: number
) => {
  sendQuestion(question, partyId, io, timeLimit, total)
  setupAnswerHandling(
    question,
    partyId,
    io,
    redis,
    quizId,
    question.number,
    eventEmitter
  )
  await questionResolve(
    io,
    redis,
    partyId,
    quizId,
    question.number,
    timeLimit,
    eventEmitter
  )

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
  questionNumber: number,
  redis: Redis,
  questionsLength: number
) => {
  const lastQuestion = questionNumber === questionsLength
  lastQuestion && io.in(partyId).emit("quiz-will-end")

  sendScorecard(quizId, partyId, redis, io, questionNumber)

  io.in(partyId).emit("begin-post-question")
  await asyncTimeout(3000)
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
  redis.expire(`score:${quizId}`, redisExpireTime)
}

/**
 * Run the quiz. Returns a promise when all questions have been looped.
 * @param questions An array of questions.
 * @param socket The socket used to communicate with the client.
 * @param redis A Redis client.
 * @param eventEmitter
 */
export const quiz = async (
  questions: Array<ProcessedQuestion>,
  partyId: string,
  redis: Redis,
  io: SocketIoServer,
  quizId: string,
  questionTimeout: number,
  eventEmitter: EventEmitter
): Promise<void> => {
  // Set up a scoreboard
  setupQuizScoresHash(quizId, partyId, redis)

  // Loop through the given questions sequentially
  for await (const question of questions) {
    await preQuestionProcedure(quizId, partyId, redis, io)
    await runQuestion(
      question,
      partyId,
      redis,
      io,
      quizId,
      questionTimeout,
      eventEmitter,
      questions.length
    )
    await postQuestionProcedure(
      io,
      partyId,
      quizId,
      question.number,
      redis,
      questions.length
    )
  }
}
