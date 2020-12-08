import redis from "redis"

require("dotenv").config() // eslint-disable-line @typescript-eslint/no-var-requires

export const setupRedis = (): redis.RedisClient => {
  const client = redis.createClient({
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT) || 6379
  })

  client.on("error", error => {
    console.error(error)
  })

  client.on("connect", () => {
    console.log("Connected to Redis")
  })

  return client
}
