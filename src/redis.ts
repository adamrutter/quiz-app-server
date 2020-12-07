import redis from "redis"

require("dotenv").config() // eslint-disable-line @typescript-eslint/no-var-requires

export const setupRedis = (): redis.RedisClient => {
  const client = redis.createClient({ url: process.env.REDIS_URL })
  return client
}
