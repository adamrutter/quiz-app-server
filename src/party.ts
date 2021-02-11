import { Redis } from "ioredis"
import { config } from "./config"
import { EventEmitter } from "events"
import { Server as SocketIoServer, Socket } from "socket.io"
import {
  uniqueNamesGenerator,
  Config,
  adjectives,
  animals
} from "unique-names-generator"
import { User } from "./types"

const { redisExpireTime } = config

/**
 * Generate a default display name
 */
const generateDefaultDisplayName = () => {
  const config: Config = {
    dictionaries: [adjectives, animals]
  }

  const name = uniqueNamesGenerator(config)
  return name
}

/**
 * Save a key to redis denoting the party leader.
 * @param userId The user being assigned party leader.
 * @param partyId The party the user is being assigned leader of.
 * @param redis The Redis client.
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
 * @param io The Socket.IO server.
 * @param eventEmitter The Node.js event emitter.
 */
export const joinParty = async (
  partyId: string,
  userId: string,
  redis: Redis,
  socket: Socket,
  io: SocketIoServer,
  eventEmitter: EventEmitter
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

  assignDisplayName(userId, partyId, redis)
    .then(() => sendUserDisplayName(userId, partyId, socket, redis))
    .then(() => sendListOfPartyMembers(partyId, redis, io))

  socket.emit("joined-party-id", partyId)

  // Listen for party user ready to start quiz
  socket.on("user-ready", (user: User) =>
    eventEmitter.emit(`${partyId}-user-ready`, user)
  )
}

/**
 * Emit the user their display name.
 * @param userId The user requesting their display name.
 * @param partyId The party the user belongs to.
 * @param socket The user's socket.
 * @param redis The Redis client.
 */
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
 * @param userId The user being assigned a display name.
 * @param partyId The party the user belongs to.
 * @param redis The Redis client.
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
  const name = existingDisplayName || generateDefaultDisplayName()
  await redis.hset(`${partyId}:display-names`, userId, name)
  redis.expire(`${partyId}:display-names`, redisExpireTime)
}

/**
 * Update a user's display name.
 * @param userId The user whose display name is being updated.
 * @param name The new display name.
 * @param partyId The party the user belongs to.
 * @param redis The Redis client.
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
 * @param partyId The party whose display names are being sent.
 * @param redis The Redis client.
 * @param io The Socket.IO server.
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

/**
 * Remove a user from a party.
 * @param userId The user being removed.
 * @param partyId The party the user is being removed from.
 * @param redis The Redis client.
 * @param io The Socket.IO server.
 */
export const removePartyMember = async (
  userId: string,
  partyId: string,
  redis: Redis,
  io: SocketIoServer
): Promise<void> => {
  // Tell clients which user has left the party
  const user = {
    id: userId,
    name: await getDisplayName(userId, partyId, redis)
  }
  io.in(partyId).emit("user-leaving-party", user)

  redis.srem(`${partyId}:members`, userId)
  redis.hdel(`score:${partyId}`, userId)
  await redis.hdel(`${partyId}:display-names`, userId)

  sendListOfPartyMembers(partyId, redis, io)
}

/**
 * Verify whether a party currently exists.
 * @param partyId The party being checked.
 * @param redis The Redis client.
 */
export const doesPartyExist = async (
  partyId: string,
  redis: Redis
): Promise<boolean> => {
  const partyMembers = await redis.smembers(`${partyId}:members`)
  const partyExists = partyMembers.length > 0
  return partyExists
}

/**
 * Retrive a user's display name.
 * @param userId The user whose display name is being retrieved.
 * @param partyId The party the user belongs to.
 * @param redis The Redis client.
 */
export const getDisplayName = async (
  userId: string,
  partyId: string,
  redis: Redis
): Promise<string | undefined> => {
  const partyNamesHash = await redis.hgetall(`${partyId}:display-names`)
  const requestedUser = Object.entries(partyNamesHash).find(
    ([id]) => id === userId
  )
  const requestedDisplayName = requestedUser?.[1]

  return requestedDisplayName
}
