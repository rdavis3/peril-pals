# PERIL PALS

**Nobody sees the whole truth.**

PERIL PALS is a cooperative asymmetric puzzle for 2–8 players. The team guides BIMO across a dangerous grid, but every device reveals a different hazard layer. Players must ping what only they can see, then the rotating navigator chooses the next step.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000`. Every new room includes a Scout Bot, so the game can be tested immediately by one person. For true asymmetric play, join the room from a second device or private browser window.

## How to play

1. Each scout sees one or more private hazard types.
2. Select a dangerous tile and press **Ping danger** to warn the team.
3. When you become navigator, select one glowing adjacent tile and move BIMO.
4. Reach the exit before time expires. Three mistakes drain the signal core.

Every generated map has at least one safe route. Missing roles are covered by Scout Bots, which send truthful public hints without exposing private hazard data.

## Multiplayer architecture

- The Node/Socket.IO server is authoritative for maps, moves, pings, timers, lives, and navigator rotation.
- Each socket receives a personalized game state containing only its assigned hazard types plus hazards already revealed to the team.
- Reconnect support preserves a scout’s role and mission state for 30 seconds.
- Host migration and turn recovery handle disconnects safely.
- Room state is intentionally ephemeral; rooms disappear when the last human leaves or the service restarts.

## Deploy on Render

The included `render.yaml` defines a free Node web service with a `/health` endpoint. Push the project to GitHub, then create a Render Blueprint from the repository. Render will install dependencies and run `npm start`.

## Contest pitch

Most multiplayer games show everyone the same world. PERIL PALS makes synchronization itself the mechanic: each device holds a different piece of the truth. The team cannot win by staring at one screen. Short missions, rotating authority, visible live pings, guaranteed-solvable maps, solo-test bots, and responsive phone controls make the concept immediately demonstrable and reliable.
