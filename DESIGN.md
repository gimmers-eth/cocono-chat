# cocono-chat Overvew

## Architecture

### Front end (FE)
FE is a PWA using no frameworks at all.

Websockets with WebRTC to send audio and video messages

Reconnection logic should be used to stop thundering heard issues...

```javascript
function reconnect(attempt: number) {
  const base = 1000;
  const max = 30000;

  const delay = Math.min(base * 2 ** attempt, max);
  const jitter = Math.random() * 1000;

  setTimeout(connect, delay + jitter);
}
```

### Back end (BE)
NodeJS based REST API, MongoDB as backend for persistent data storage.

Nodejs will use ws to connect clients to the websocket server, and a simple HTTP-based WebSocket client in the FE app is
used to send/receive text messages.

REDIS will be used for storing session information including chat history etc.

WebRTC used for audio and video transmissions between the two parties.

- Heartbeat will be used to keep sessions alive and drop any dead connections.

REMEMBER to check file discriptors on OS
```bash
ulimit -n
```

Raise it:

```bash
ulimit -n 100000
```

Persist in /etc/security/limits.conf:
```
* soft nofile 100000
* hard nofile 100000
```
### Users & Encryption

Each user will have an account that they can connect to using multiple devices.
The username must be at least five characters long and contain only alphanumeric characters, underscores (_), or dashes
(-).

Users cannot change their username once it has been set.

When a user creates their account, they will generate a public and private key pair.
- The private key is never exposed to the FE app.
- Only the public key can be sent out over the network to other users.
- The private and public key (Ed25519) is generated using window.crypto.subtle.generateKey(...)
- The private key is not exportable.

A AES-GCM key is also generated as exportable and then sent to the server using a signed message 
- using the ed25519 key
- Once this has been done, the user will be able to send/receive messages to the server encrypted with the AES-GCM key.
- After the server has received the key, the client re-imports it back into the crypto.subtle API as non-exportable

A new user creation data object sent to the server looks as follows...

{
    u: string // username
    p: string // public key of user
    a: string // AES key of user
}

This will be json-encoded and then sent as a message to the server. 

A message sent to the server from client looks as follows...
{
    m: {
        d: string // data/message being sent
        u: string // user/group this is for or "server" to send to the server
        t: string // timestamp of the message being sent
        h: string // HMAC generated using the above message and the private key
    }
    s: string // signature created using ED25519 signing algorithm and message
}

Once a user has been created the message data (m.d) will be encrypted with AES key of user, and depending on the message
the user may just encrypy the message without signing.

Messages that need signing
- New user creation
- New device adding
- changing AES keys
- Optionally sign any message
- ???

#### New Device Adding
A user can add a new public and AES key to their account for a new device.
- User sends a message like the new user message from the new device
- Server generates a 6 digit code
- The user confirms the code on an existing device already added to the users account

### Message Flow on BE

Once the server receives a new message, it is added to a message queue using a sub/pub pattern like the following...

```javascript
import { WebSocketServer } from 'ws';
import { createClient } from 'redis';

const wss = new WebSocketServer({ port: 3000 });

const pub = createClient({ url: process.env.REDIS_URL });
const sub = createClient({ url: process.env.REDIS_URL });

await pub.connect();
await sub.connect();

const localClients = new Map();

wss.on('connection', (ws) => {
    
  // check the username and ensure the user has signed their username using the private key (maybe in the header)

  ws.on('message', async (msg) => {
    // decode message as JSON
    // check message.u exists
    // if msg.u === 'server' then publish to server queue
    // else...
    await pub.publish('msg', msg.toString());
  });

  ws.on('close', () => localClients.delete(ws));
});

await sub.subscribe('msg', (message) => {
    // get list of clients from msg.u (group or individual user)
    // check ready state before sending the message...
    // if (client.readyState === client.OPEN) {
    //   client.send(message);
    // }
});
```

In real implementation, workers should be used to reduce latency spikes in the main loop/thread.

Updates and massive data writes should be done via REST API (user changes, new user creation etc). to avoid lagging

### Organisation of messages

- Users
- Groups
- subgroups - can be created in a group from a message in the main group chat, or just as a new sub-group. Members CHOOSE to join or not.
- Special subgroups - Additional subgroups that can be created and other members can be added without adding to the main group (i.e. kids can be added)
- message tags - creates a personal psudo sub-group that holds the messages for future refereence 