import { Redis } from "ioredis"
import { Server as SocketIoServer, Socket } from "socket.io"

/**
 * Add a user to the requested party. Also add them to the party's scorecard.
 * @param partyId The party ID received from the client.
 * @param userId The user ID received from the client.
 * @param redis A Redis client.
 */
export const joinParty = (
  partyId: string,
  userId: string,
  redis: Redis,
  socket: Socket
): void => {
  redis.sadd(`${partyId}:members`, userId)
  redis.hset(`score:${partyId}`, `${userId}`, 0)
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
}

/**
 * Send the list of party display names to all clients in the party.
 * @param partyId
 * @param redis
 * @param io
 */
export const sendAllPartyDisplayNames = async (
  partyId: string,
  redis: Redis,
  io: SocketIoServer
): Promise<void> => {
  const partyNamesHash = await redis.hgetall(`${partyId}:display-names`)
  io.in(partyId).emit("party-members", partyNamesHash)
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
