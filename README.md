[Client repo can be found here](https://github.com/adamrutter/quiz-app-client).

# Quiz App

A multiplayer quiz app built made with React and Socket<span>.</span>IO. [You can find a live version of the app here](https://quiz.adamrutter.com).

## Technologies used

### Server

- Typescript
- Socket<span>.</span>IO
- Redis
- Open Trivia Datbase
- Heroku

### Client

- create-react-app
- Typescript
- Socket<span>.</span>IO
- Chakra UI
- Netlify

## Why?

I built this app as a project to learn Typescript and check out Chakra UI.

I quickly realised it would be a lot more fun being multiplayer (especially during lockdown), so it also became a project to learn Socket<span>.</span>IO.

It then followed that I needed somewhere to store data, so I also added Redis to the list of tools being learned!

## Local installation

1. Install Redis on your machine. [Info on how to install Redis here](https://redis.io/download).
2. Clone both repos:

```
git clone https://github.com/adamrutter/quiz-app-client/
git clone https://github.com/adamrutter/quiz-app-server/
```

3. Add `REACT_APP_SERVER_URL: localhost:5000` to `quiz-app-client/.env.local`
4. `npm install` in both repos.
5. `npm run dev` in the server repo.
6. `npm start` in the client repo.

## License

Released under the GNU General Public License v2. See `LICENSE` for more details.
