import { Redis } from "ioredis"
import { Socket } from "socket.io"

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
