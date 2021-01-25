import { Socket } from "socket.io"

export const emitErrorMessageToSocket = (
  message: string,
  socket: Socket
): void => {
  socket.emit("error", message)
}
