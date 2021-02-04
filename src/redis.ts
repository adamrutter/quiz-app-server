import Redis, { Redis as RedisType } from "ioredis"

require("dotenv").config() // eslint-disable-line @typescript-eslint/no-var-requires

export const setupRedis = (): RedisType => {
  const redis = new Redis({
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || ""
  })

  redis.on("error", error => {
    console.error(error)
  })

  redis.on("connect", () => {
    console.log("Connected to Redis")
  })

  return redis
}
