import { clearInterval } from "timers"
import { Socket } from "socket.io"
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
export const questionTimer = (
  timeout: number,
  socket: Socket
): Promise<void> => {
  return new Promise<void>(resolve => {
    let secondsLeft = timeout / 1000
    socket.emit("timer-update", secondsLeft)

    const timer = setInterval(() => {
      secondsLeft--

      if (secondsLeft === 0) {
        clearInterval(timer)
        resolve()
      }

      socket.emit("timer-update", secondsLeft)
    }, 1000)
  })
}

/**
 * Send a question to the client. Returns a promise.
 * @param question The question to send.
 * @param socket The socket used to send the question.
 * @param timer An optional timer function to delay returning the promise.
 * @param timeout The timeout for the optional timer function.
 */
export const sendQuestion = (
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
