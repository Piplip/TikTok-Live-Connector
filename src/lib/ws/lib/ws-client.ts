import { client as WebSocket, connection as WebSocketConnection, Message as WebSocketMessage } from 'websocket';
import * as http from 'node:http';
import { BinaryWriter } from '@bufbuild/protobuf/wire';
import { DecodedWebcastPushFrame, WebSocketParams } from '@/types/client';
import { createBaseWebcastPushFrame, deserializeWebSocketMessage } from '@/lib/utilities';
import Config from '@/lib/config';
import TypedEventEmitter from 'typed-emitter';
import CookieJar from '@/lib/web/lib/cookie-jar';
import { HeartbeatMessage, WebcastImEnterRoomMessage } from '@/types';

const textEncoder = new TextEncoder();

type EventMap = {
    connect: (connection: WebSocketConnection) => void;
    close: () => void;
    messageDecodingFailed: (error: Error) => void;
    unknownResponse: (message: WebSocketMessage) => void;
    protoMessageFetchResult: (response: any) => void;
    webSocketData: (data: Uint8Array) => void;
    imEnteredRoom: (decodedContainer: DecodedWebcastPushFrame) => void;
};

type TypedWebSocket = WebSocket & TypedEventEmitter<EventMap>;
type WebSocketConstructor = new () => TypedWebSocket;


export default class TikTokWsClient extends (WebSocket as WebSocketConstructor) {
    public connection: WebSocketConnection | null;
    protected pingInterval: NodeJS.Timeout | null;
    protected wsHeaders: Record<string, string>;
    protected wsUrlWithParams: string;

    constructor(
        wsUrl: string,
        cookieJar: CookieJar,
        protected readonly webSocketParams: WebSocketParams,
        webSocketHeaders: Record<string, string>,
        webSocketOptions: http.RequestOptions,
        protected webSocketPingIntervalMs: number = 10000
    ) {
        super();

        this.pingInterval = null;
        this.connection = null;
        this.wsUrlWithParams = `${wsUrl}?${new URLSearchParams(this.webSocketParams)}${Config.DEFAULT_WS_CLIENT_PARAMS_APPEND_PARAMETER}`;
        this.wsHeaders = { Cookie: cookieJar.getCookieString(), ...(webSocketHeaders || {}) };
        this.on('connect', this.onConnect.bind(this));
        this.connect(this.wsUrlWithParams, '', `https://${Config.TIKTOK_HOST_WEB}`, this.wsHeaders, webSocketOptions);
    }

    protected onConnect(wsConnection: WebSocketConnection) {
        this.sendHeartbeat();
        this.connection = wsConnection;
        this.pingInterval = setInterval(() => this.sendHeartbeat(), this.webSocketPingIntervalMs);
        this.connection.on('message', this.onMessage.bind(this));
        this.connection.on('close', this.onDisconnect.bind(this));
    }

    /**
     * Send a message to the WebSocket server
     * @param data The message to send
     * @returns True if the message was sent, false otherwise
     */
    public sendBytes(data: Uint8Array): boolean {
        if (this.connection) {
            this.connection.sendBytes(Buffer.from(data));
            return true;
        }
        return false;
    }

    protected onDisconnect() {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
        this.connection = null;
        this.emit('close');
    }

    /**
     * Handle incoming messages
     * @param message The incoming WebSocket message
     * @protected
     */
    protected async onMessage(message: WebSocketMessage) {

        // Emit WebSocket data
        this.emit('webSocketData', message);

        // If the message is not binary, emit an unknown response
        if (message.type !== 'binary') {
            return this.emit('unknownResponse', message);
        }

        //  If the message is binary, decode it
        try {
            const decodedContainer: DecodedWebcastPushFrame = await deserializeWebSocketMessage(message.binaryData);

            // If the message has a decoded protoMessageFetchResult, emit it
            if (decodedContainer.protoMessageFetchResult) {

                // If it needs an ack, send the ack
                if (decodedContainer.protoMessageFetchResult.needsAck) {
                    this.sendAck(decodedContainer);
                }

                this.emit('protoMessageFetchResult', decodedContainer.protoMessageFetchResult);
            }

            // If it's a room enter, emit
            if (decodedContainer.payloadType === 'im_enter_room_resp') {
                this.emit('imEnteredRoom', decodedContainer);
            }

        } catch (err) {
            this.emit('messageDecodingFailed', err);
        }

    }

    /**
     * Static Keep-Alive ping
     */
    protected sendHeartbeat() {
        const { room_id } = this.webSocketParams;

        // Create the heartbeat
        const hb: BinaryWriter = HeartbeatMessage.encode({ roomId: room_id });

        // Wrap it in the WebcastPushFrame
        const webcastPushFrame: BinaryWriter = createBaseWebcastPushFrame(
            {
                payloadEncoding: 'pb',
                payloadType: 'hb',
                payload: hb.finish(),
                service: undefined,
                method: undefined,
                headers: {}
            }
        );

        this.sendBytes(Buffer.from(webcastPushFrame.finish()));
    }

    /**
     * EXPERIMENTAL: Switch to a different TikTok LIVE room while connected to the WebSocket
     * @param roomId The room ID to switch to
     */
    public switchRooms(roomId: string): void {

        const imEnterRoomMessage: BinaryWriter = WebcastImEnterRoomMessage.encode(
            {
                roomId: roomId,
                roomTag: '',
                liveRegion: '',
                liveId: '12', // Static value for all streams (via decompiled APK)
                identity: 'audience',
                cursor: '',
                accountType: '0',
                enterUniqueId: '',
                filterWelcomeMsg: '0',
                isAnchorContinueKeepMsg: false
            }
        );

        const webcastPushFrame: BinaryWriter = createBaseWebcastPushFrame(
            {
                payloadEncoding: 'pb',
                payloadType: 'im_enter_room',
                payload: imEnterRoomMessage.finish()
            }
        );

        this.sendBytes(Buffer.from(webcastPushFrame.finish()));

    }


    /**
     * Acknowledge the message was received
     */
    protected sendAck({ logId, protoMessageFetchResult: { internalExt } }: DecodedWebcastPushFrame): void {

        // Always send an ACK for the message
        if (!logId) {
            return;
        }

        const webcastPushFrame: BinaryWriter = createBaseWebcastPushFrame(
            {
                logId: logId,
                payloadEncoding: 'pb',
                payloadType: 'ack',
                payload: textEncoder.encode(internalExt)
            }
        );

        this.sendBytes(Buffer.from(webcastPushFrame.finish()));
    }

    /**
     * Close the WebSocket connection
     */
    public close(): Promise<void> {

        return new Promise((resolve) => {
            this.once('close', () => resolve());

            // If connected, disconnect
            if (this.connection) {
                this.connection.close(1000);
            }
            // Otherwise immediately resolve
            else {
                resolve();
            }

        });

    }
}

