import { Redis } from "ioredis"
import { config } from "./config"
import { Server as SocketIoServer, Socket } from "socket.io"

const { redisExpireTime } = config

/**
 * Save a key to redis denoting the party leader.
 * @param userId
 * @param partyId
 * @param redis
 */
const assignPartyLeader = (userId: string, partyId: string, redis: Redis) => {
  redis.set(`${partyId}:party-leader`, userId)
  redis.expire(`${partyId}:party-leader`, redisExpireTime)
}

/**
 * Add a user to the requested party. Also add them to the party's scorecard.
 * @param partyId The party ID received from the client.
 * @param userId The user ID received from the client.
 * @param redis A Redis client.
 */
export const joinParty = async (
  partyId: string,
  userId: string,
  redis: Redis,
  socket: Socket
): Promise<void> => {
  // If party has 0 members (ie, this is a new party), assign this member as
  // party leader
  const partyMembers = await redis.smembers(`${partyId}:members`)
  if (partyMembers.length === 0) {
    assignPartyLeader(userId, partyId, redis)
  }

  redis.sadd(`${partyId}:members`, userId)
  redis.expire(`${partyId}:members`, redisExpireTime)
  redis.hset(`score:${partyId}`, `${userId}`, 0)
  redis.expire(`score:${partyId}`, redisExpireTime)

  socket.emit("joined-party-id", partyId)
}

export const sendUserDisplayName = async (
  userId: string,
  partyId: string,
  socket: Socket,
  redis: Redis
): Promise<void> => {
  const name = await redis.hget(`${partyId}:display-names`, userId)
  socket.emit("display-name", name)
}

/**
 * Assign a display name to a user. Assigns the user's already chosen display if
 * possible.
 * @param userId
 * @param partyId
 * @param redis
 */
export const assignDisplayName = async (
  userId: string,
  partyId: string,
  redis: Redis
): Promise<void> => {
  const existingDisplayName = await redis.hget(
    `${partyId}:display-names`,
    userId
  )
  const name = existingDisplayName || `user_${userId?.substring(0, 3)}`
  await redis.hset(`${partyId}:display-names`, userId, name)
  redis.expire(`${partyId}:display-names`, redisExpireTime)
}

/**
 * Update a user's display name.
 * @param partyId
 * @param redis
 * @param socket
 */
export const changeDisplayName = async (
  userId: string,
  name: string,
  partyId: string,
  redis: Redis
): Promise<void> => {
  await redis.hset(`${partyId}:display-names`, userId, name)
  redis.expire(`${partyId}:display-names`, redisExpireTime)
}

/**
 * Send the list of party display names to all clients in the party.
 * @param partyId
 * @param redis
 * @param io
 */
export const sendListOfPartyMembers = async (
  partyId: string,
  redis: Redis,
  io: SocketIoServer
): Promise<void> => {
  const partyNamesHash = await redis.hgetall(`${partyId}:display-names`)
  const partyLeader = await redis.get(`${partyId}:party-leader`)

  const members = Object.entries(partyNamesHash).map(([id, name]) => {
    const isUserPartyLeader = partyLeader === id
    return {
      id,
      name,
      leader: isUserPartyLeader
    }
  })

  io.in(partyId).emit("party-members", members)
}

export const removePartyMember = async (
  userId: string,
  partyId: string,
  redis: Redis
): Promise<void> => {
  redis.srem(`${partyId}:members`, userId)
  redis.hdel(`score:${partyId}`, userId)
  redis.hdel(`${partyId}:display-names`, userId)
}

export const doesPartyExist = async (
  partyId: string,
  redis: Redis
): Promise<boolean> => {
  const partyMembers = await redis.smembers(`${partyId}:members`)
  const partyExists = partyMembers.length > 0
  return partyExists
}
