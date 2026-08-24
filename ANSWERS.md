## 1. Contradictions & Ambiguities in DESIGN.md
1. Did you mean the private key is never exposed to the server/network
2. Redis used for pub/sub and Mongo used for long term persistence if not in memory
3. HMAC keyed with the AES-GCM key
4. A websocket is established via a HTTP upgrade request
5. plain JS
6. Chat

## 2. Product Scope & MVP
1. Agree
2. Later - Text only 1st
3. The design should scale from the start, but initially will be deployed on basic hardware. 10k users first, but should be easy to horizontally scale.
4. Self hosted or AWS. Initially self hosted. Minimal CI infrastructure.

## 3. Accounts, Devices & Recovery
1. First to register the username with a private key & AES key
2. This is expected. Messages will all be lost. Later we may allow email recovery of the username.
3.  case-insensitive uniqueness (aBc will be the same as abc) with reserved names configurable.
4. 10 minutes validity (configurable in .env) with all data passed encrypted to the new device. Chat history groups etc.
5. Configurable, starting with 3. Per account configurable by admin server side. Later this could be premuim feature.
6. Any messages are encrypted and only stored on Redis/MongoDB until they have been read and stored on the device. If the user deletes the key, they have lost the access. We will later add backup options.

## 4. Accounts, Devices & Recovery
1. This is only sent for client <-> server messages, eacg user <-> user interaction will have its own AES key, like WhatsAPP
2. The public and private keys are used for this.
3. Yes - recipient u, timestamp t, group membership, message sizes
4. When a group changes a user and when a new convversation is started.
5. Fallback is fine.
6. IndexedDB, yes. If the srotage is cleared the user has the access lost until we implement a backup feature.
7. We will implement a per account rate limit as well as a per IP rate limit to the signup endpoints.
8. We only keep until the user downloads the message on the device. We will look to do REDIS -> afer x minutes move to Mongo -> After X days deleted as undelivered

## 5. Messaging & Delivery Guarantees
1. Same as 4.8 REDIS then mongo. Maybe straight to mongo if the user is offline.
2. Pull on reconnect. All messages are encrypted per device so pull all and remove from server. If a device other than the main device is inactive for 14 days, the device is removed and pending messages deleted. 
3. Server assigned
4. Server assigned timestamps
5. We know if read if they dont exist, so if a client keeps track of sent messages we can let the sender know when the message has been received.
6. Server.
7. visibilitychange handling and navigator.onLine hooks would be good.
8. Max group size 20. We will need to consider how larger groups will work at a later date.

## 6. Message Organisation (Groups, Subgroups, Tags)
1. when a member leaves, there is no history to manage, the leaving member still has the history in memory, they can just not send to the group. The remaining group members cycle keys.
2. Yes it linkes back. The creator picks members.
3. Yes they can see and choose to join or not.
4. Same permissions really.
5. Private to tagging user - yes. Only a pointer to the message. All messages are only stored on the client once pulled.
6. Yes

## 7. PWA / Front End
1. No bundler.
2. Visibility of messages already pulled down by the client. Message tags and the like.
3. Web Push with VAPID Keys yes
4. They should be stored on the device when they download the message. By default media is deleted after 24h of downloading, but the user can mark to save it long term. Later a media addon to store media on the server long term may be useful as a premium offering.
5. The app should only work on one tab per device.

## 8. Back End Architecture & Operations
1. Bare minimum, but fastify allowed, maybe also the WS plugin if scalable
2. All work other than pub/sub goes to workers. We are using REDIS and worker_threads
3. Lets make signup via rest - JWT auth.
4. identity passed in headers/query at upgrade time
5. I do not think we need sticky sessions, REST API hits should be stateless, and the websocket connection should be stateless. We can use a sticky session for the websocket connection, but it is not necessary unless there is a specific reason to do so??
6. TLS is nginx - Deployment will be pm2 and pulling the code from github initially. Later maybe kubernetes. OS = Ubuntu or Amazon linux
7. Daily backup initially. Redis will have a replica set for high availability. We can explore options for logging, alerts and metrics. Somethign simple and not resource intensive
8. Optional local or remote/network dev server to connect.

## 9. WebRTC & Media
1. For now we will only do voice messages, file uploads (images/vis) and text we can explore real time later
2. STUN/TURN we will host when needed.
3. They will be in-scope. Unsure where stored yet. Post MVP problem. Likely S3 style.
4. Never say never, but 1:1 calls will be in scope post MVP.
5. Post MVP.

## 10. Delivery, Milestones & Repo
1. Users, multiple devices, encrypted messages, media sharing and groups with offline delivery.
2. 1 account, 2 multi-device, 3 1:1 messages (text), 4 files (images etc), 5 groups, 6 PWA polish, 7 subgroups.
3. Yes!
4. Monorepo