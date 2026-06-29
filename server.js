// server.js
import { serveDir } from "jsr:@std/http/file-server";

const kv = await Deno.openKv();

// クラウド環境で全サーバーが共通して使う「部屋のID」
const ROOM_KEY = ["shiritori_room_data"];

// 対戦に必要なプレイヤー数（3人目以降は観戦者になる）
const MAX_PLAYERS = 2;

// サーバー起動時にデータベースの初期状態をセット
const existing = await kv.get(ROOM_KEY);
if (!existing.value) {
    await kv.set(ROOM_KEY, {
        wordHistory: ["しりとり"],
        turnIndex: 0,
        gameStarted: false,
    });
}

// 接続中のプレイヤー・観戦者（WebSocketは保存できないため、これらはローカル変数のままでよい）
let connectedClients = [];
let spectators = [];

const toHiragana = (str) => {
    return str.replace(/[\u30a1-\u30f6]/g, (match) => {
        return String.fromCharCode(match.charCodeAt(0) - 0x60);
    });
};

// 2回以上連続する伸ばし棒「ー」を1回に圧縮する（サーバー内の複数箇所で使う共通処理）
const compressChouon = (str) => {
    return str.replace(/ー+/g, "ー");
};

const getNextChar = (word) => {
    if (!word) return "";

    // 1. 伸ばし棒の連続を圧縮
    const cleaned = compressChouon(word);

    // 2. 末尾の文字を取得
    let lastChar = cleaned.slice(-1);

    // 3. 末尾が伸ばし棒なら、その1つ前の文字を取得
    if (lastChar === "ー" && cleaned.length > 1) {
        lastChar = cleaned.slice(-2, -1);
    }

    // 4. 平仮名に変換
    let nextChar = toHiragana(lastChar);

    // 5. 小文字（ぁ、ゃ 等）を大文字（あ、や 等）に変換
    const smallToLarge = {
        "ぁ": "あ",
        "ぃ": "い",
        "ぅ": "う",
        "ぇ": "え",
        "ぉ": "お",
        "ゃ": "や",
        "ゅ": "ゆ",
        "ょ": "よ",
        "っ": "つ",
    };
    if (smallToLarge[nextChar]) {
        nextChar = smallToLarge[nextChar];
    }

    return nextChar;
};

// 全員にJSONデータを送るヘルパー関数
function broadcast(data, roomData) {
    connectedClients.forEach((client, index) => {
        if (client.readyState === WebSocket.OPEN) {
            // サーバー上部の変数ではなく、引数で受け取った最新のDBデータを基準に手番判定
            const isYourTurn = index === roomData.turnIndex;
            client.send(JSON.stringify({
                ...data,
                isYourTurn: isYourTurn,
                role: "player",
            }));
        }
    });

    spectators.forEach((spectator) => {
        if (spectator.readyState === WebSocket.OPEN) {
            spectator.send(JSON.stringify({
                ...data,
                isYourTurn: false,
                role: "spectator",
            }));
        }
    });
}

function broadcastGameOver(
    loserSocket,
    loserMessage,
    winnerMessage,
    wordCount,
) {
    //歯医者に送信
    loserSocket.send(JSON.stringify({
        "type": "gameover",
        "result": "lose",
        "role": "player",
        "errorMessage": loserMessage,
        "wordCount": wordCount,
    }));
    //勝者に送信
    connectedClients.forEach((client) => {
        if (
            client !== loserSocket &&
            client.readyState === WebSocket.OPEN
        ) {
            client.send(JSON.stringify({
                "type": "gameover",
                "result": "win",
                "role": "player",
                "errorMessage": winnerMessage,
                "wordCount": wordCount,
            }));
        }
    });
    //観戦者に送信
    spectators.forEach((spectator) => {
        if (spectator.readyState === WebSocket.OPEN) {
            spectator.send(JSON.stringify({
                "type": "gameover",
                "role": "spectator",
                "errorMessage": "試合が終了しました！",
                "wordCount": wordCount,
            }));
        }
    });
}

// localhostにDenoのHTTPサーバーを展開
Deno.serve(async (_req) => {
    // パス名を取得する
    // http://localhost:8000/hoge に接続した場合"/hoge"が取得できる
    const pathname = new URL(_req.url).pathname;

    if (pathname === "/shiritori-ws") {
        const { response, socket } = Deno.upgradeWebSocket(_req);

        socket.onopen = async () => {
            console.log("プレイヤー参戦！");
            const entry = await kv.get(ROOM_KEY);
            let roomData = entry.value;
            // 3人目以降の接続は観戦者モード
            if (connectedClients.length >= MAX_PLAYERS) {
                spectators.push(socket);

                const lastWord =
                    roomData.wordHistory[roomData.wordHistory.length - 1] ||
                    "しりとり";
                const initialNextChar = getNextChar(lastWord);

                socket.send(JSON.stringify({
                    "type": "spectate_start",
                    "role": "spectator",
                    "word": lastWord,
                    "recentWords": roomData.wordHistory.slice(-5),
                    "nextChar": initialNextChar,
                    "message": "満員のため観戦モードで参加中",
                }));
                return;
            }

            connectedClients.push(socket);

            if (connectedClients.length === 1) {
                roomData.gameStarted = false;
                await kv.set(ROOM_KEY, roomData);
                socket.send(JSON.stringify({
                    "type": "waiting",
                    "role": "player",
                    "message": "対戦相手を待っています...",
                }));
            } else if (connectedClients.length === MAX_PLAYERS) {
                // 定員に達したらゲーム開始！
                roomData.gameStarted = true;

                // 先攻後攻をランダムで決めてDBに書き込む
                roomData.turnIndex = Math.floor(Math.random() * MAX_PLAYERS);
                await kv.set(ROOM_KEY, roomData);

                console.log(
                    `ゲーム開始！先攻プレイヤーのインデックス: ${roomData.turnIndex}`,
                );

                const currentWord =
                    roomData.wordHistory[roomData.wordHistory.length - 1];
                const recentWordsList = roomData.wordHistory.slice(-5);

                const startNextChar = getNextChar(currentWord);

                // 定員に達したので、それぞれのプレイヤーに手番を送る
                connectedClients.forEach((client, index) => {
                    if (client.readyState === WebSocket.OPEN) {
                        const isYourTurn = index === roomData.turnIndex;
                        client.send(JSON.stringify({
                            "type": "game_start",
                            "word": currentWord,
                            "recentWords": recentWordsList,
                            "nextChar": startNextChar,
                            "isYourTurn": isYourTurn,
                            "role": "player",
                        }));
                    }
                });

                // 観戦者へ送信
                spectators.forEach((spectator) => {
                    if (spectator.readyState === WebSocket.OPEN) {
                        spectator.send(JSON.stringify({
                            "type": "game_start",
                            "word": currentWord,
                            "recentWords": recentWordsList,
                            "isYourTurn": false,
                            "role": "spectator",
                        }));
                    }
                });
            }
        };

        socket.onclose = async () => {
            console.log("プレイヤー退場ッ！");
            connectedClients = connectedClients.filter((client) =>
                client !== socket
            );
            if (connectedClients.length < MAX_PLAYERS) {
                if (connectedClients.length === 0) {
                    await kv.set(ROOM_KEY, {
                        wordHistory: ["しりとり"],
                        turnIndex: 0,
                        gameStarted: false,
                    });
                    console.log(
                        "全員退場したためデータをリセットしました。",
                    );
                    return;
                }
                // もし1人残されたら、その人を再び待機状態にする
                if (connectedClients.length === 1) {
                    connectedClients[0].send(JSON.stringify({
                        "type": "waiting",
                        "message":
                            "対戦相手が切断しました;;新たな相手を待っています...",
                    }));
                }
            }
        };

        socket.onmessage = async (event) => {
            const nextWord = event.data.trim();
            const entry = await kv.get(ROOM_KEY);
            let roomData = entry.value;
            let wordHistoryFromDB = roomData.wordHistory;

            //手番プレイヤーからの送信かチェック
            const currentPlayerSocket = connectedClients[roomData.turnIndex];
            if (socket !== currentPlayerSocket) {
                // 自分のターンじゃない奴からのメッセージは無視する
                return;
            }

            // 文字の正規化（標準化）処理
            const previousWord =
                wordHistoryFromDB[wordHistoryFromDB.length - 1];

            // 入力された単語の連続する伸ばし棒をあらかじめ破壊（圧縮）
            const cleanedNextWord = compressChouon(nextWord);

            // 重複チェック用の平仮名変換（圧縮済みの単語を使用）
            const nextWordHiragana = toHiragana(cleanedNextWord);

            // 過去の履歴もすべて「伸ばし棒圧縮＋ひらがな」に統一したチェック専用配列を作る
            const hiraganaHistory = wordHistoryFromDB.map((word) =>
                toHiragana(compressChouon(word))
            );

            //重複チェック
            if (hiraganaHistory.includes(nextWordHiragana)) {
                broadcastGameOver(
                    socket,
                    `「${nextWord}」はすでに使われている単語です！`,
                    `相手が「${nextWord}」という重複した単語を使いました！`,
                    wordHistoryFromDB.length,
                );
                return;
            }

            //次に繋げるスタート文字の判定（圧縮済みの先頭文字を取る）
            const nextStart = toHiragana(cleanedNextWord.slice(0, 1));

            // 直前の単語（DBの末尾）も連続伸ばし棒を破壊してから最後の文字を判定する
            const previousEnd = getNextChar(previousWord);

            // しりとり接続チェック
            if (previousEnd !== nextStart) {
                broadcastGameOver(
                    socket,
                    `「${nextWord}」は「${previousEnd}」に続いていません！`,
                    `相手が「${previousEnd}」に続かない単語「${nextWord}」を入力しました！`,
                    wordHistoryFromDB.length,
                );
                return;
            }

            // 「ん」チェック
            if (toHiragana(nextWord.slice(-1)) === "ん") {
                broadcastGameOver(
                    socket,
                    `末尾が「ん」で終わっています！`,
                    `相手が「ん」のつく単語を入力しました！`,
                    wordHistoryFromDB.length,
                );
                return;
            }

            // 全てのチェックをクリアしたら履歴に追加
            wordHistoryFromDB.push(nextWord);
            const recentWords = wordHistoryFromDB.slice(-5);

            roomData.turnIndex = (roomData.turnIndex + 1) % MAX_PLAYERS;
            roomData.wordHistory = wordHistoryFromDB;

            //更新した最新状態をデータベースに保存（これで他のサーバーにも一瞬で同期される）
            await kv.set(ROOM_KEY, roomData);

            const calculatedNextChar = getNextChar(nextWord);

            //正しいJSONデータ形式で全員に一斉送信
            broadcast({
                "type": "success",
                "word": nextWord,
                "recentWords": recentWords,
                "nextChar": calculatedNextChar,
            }, roomData);
        };

        return response;
    }

    console.log(`pathname: ${pathname}`);

    // GET /shiritori: 直前の単語を返す
    if (_req.method === "GET" && pathname === "/shiritori") {
        const entry = await kv.get(ROOM_KEY);
        const roomData = entry.value;
        const nextWord = roomData.wordHistory[roomData.wordHistory.length - 1];
        const recentWords = roomData.wordHistory.slice(-5); // 最初も過去5件を切り出す

        const initialNextChar = getNextChar(nextWord);

        // WebSocketの成功時と同じ形のJSONデータを返すようにする
        return new Response(
            JSON.stringify({
                "type": "success",
                "word": nextWord,
                "recentWords": recentWords,
                "nextChar": initialNextChar,
            }),
            {
                headers: { "Content-Type": "application/json; charset=utf-8" },
            },
        );
    }

    if (_req.method === "POST" && pathname === "/reset") {
        // 履歴を最初の「しりとり」だけの状態に戻す
        await kv.set(ROOM_KEY, {
            wordHistory: ["しりとり"],
            turnIndex: 0,
            gameStarted: false,
        });

        console.log("履歴がリセットされました");
        return new Response(JSON.stringify({ "message": "リセット完了" }), {
            status: 200,
            headers: { "Content-Type": "application/json; charset=utf-8" },
        });
    }

    // ./public以下のファイルを公開
    return serveDir(
        _req,
        {
            /*
            - fsRoot: 公開するフォルダを指定
            - urlRoot: フォルダを展開するURLを指定。今回はlocalhost:8000/に直に展開する
            - enableCors: CORSの設定を付加するか
            */
            fsRoot: "./public/",
            urlRoot: "",
            enableCors: true,
        },
    );
});
