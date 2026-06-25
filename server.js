// server.js
import { serveDir } from "jsr:@std/http/file-server";

//直前の単語を保持しておく
let wordHistory = ["しりとり"];
let connectedClients = [];
let turnIndex = 0; // 現在何番目のプレイヤーのターンか（0または1）

// 全員にJSONデータを送るヘルパー関数
function broadcast(data) {
    connectedClients.forEach((clients, index) => {
        if (clients.readyState === WebSocket.OPEN) {
            const isYourTurn = index === turnIndex;

            const personallizedData = {
                ...data,
                isYourTurn: isYourTurn,
            };

            clients.send(JSON.stringify(personallizedData));
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

        socket.onopen = () => {
            console.log("プレイヤー参戦！");
            connectedClients.push(socket);
        };

        socket.onclose = () => {
            console.log("プレイヤー退場ッ！");
            connectedClients = connectedClients.filter((client) =>
                client !== socket
            );

            turnIndex = 0;
        };

        //
        socket.onmessage = (event) => {
            // 1. 手番プレイヤーからの送信かチェック
            const currentPlayerSocket = connectedClients[turnIndex];
            if (socket !== currentPlayerSocket) {
                // 自分のターンじゃない奴からのメッセージは無視する
                return;
            }

            const nextWord = event.data.trim();

            // 重複チェック
            if (wordHistory.includes(nextWord)) {
                broadcast({
                    "type": "gameover",
                    "errorCode": "10003",
                    "errorMessage": `「${nextWord}」はすでに使われています！`,
                });
                return;
            }

            // 文字の正規化（標準化）処理
            const rawPreviousWord = wordHistory[wordHistory.length - 1];
            const toHiragana = (str) => {
                return str.replace(/[\u30a1-\u30f6]/g, (match) => {
                    return String.fromCharCode(match.charCodeAt(0) - 0x60);
                });
            };

            const nextStart = toHiragana(nextWord.slice(0, 1));
            let lastChar = rawPreviousWord.slice(-1);

            if (lastChar === "ー" && rawPreviousWord.length > 1) {
                lastChar = rawPreviousWord.slice(-2, -1);
            }

            let previousEnd = toHiragana(lastChar);

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
            if (smallToLarge[previousEnd]) {
                previousEnd = smallToLarge[previousEnd];
            }

            // しりとり接続チェック
            if (previousEnd !== nextStart) {
                broadcast({
                    "type": "gameover",
                    "errorCode": "10001",
                    "errorMessage":
                        `「${nextWord}」は「${previousEnd}」に続いていません！`,
                });
                return;
            }

            // 「ん」チェック
            if (toHiragana(nextWord.slice(-1)) === "ん") {
                broadcast({
                    "type": "gameover",
                    "errorCode": "10002",
                    "errorMessage": `末尾が「ん」で終わっています！`,
                });
                return;
            }

            // 全てのチェックをクリアしたら履歴に追加
            wordHistory.push(nextWord);
            const recentWords = wordHistory.slice(-5);

            // 2. 次のプレイヤーにターンを譲る
            // 2人対戦なら 0 ➔ 1 ➔ 0 ➔ 1 と交互に入れ替わる
            turnIndex = (turnIndex + 1) % connectedClients.length;

            // 全員に通知（進化したbroadcastを呼ぶ）
            broadcast({
                "type": "success",
                "word": nextWord,
                "recentWords": recentWords,
            });

            //正しいJSONデータ形式で全員に一斉送信！
            broadcast({
                "type": "success",
                "word": nextWord,
                "recentWords": recentWords,
            });
        };

        return response;
    }

    console.log(`pathname: ${pathname}`);

    // GET /shiritori: 直前の単語を返す
    if (_req.method === "GET" && pathname === "/shiritori") {
        const nextWord = wordHistory[wordHistory.length - 1];
        const recentWords = wordHistory.slice(-5); // 最初も過去5件を切り出す

        // WebSocketの成功時と同じ形のJSONデータを返すようにする
        return new Response(
            JSON.stringify({
                "type": "success",
                "word": nextWord,
                "recentWords": recentWords,
            }),
            {
                headers: { "Content-Type": "application/json; charset=utf-8" },
            },
        );
    }

    if (_req.method === "POST" && pathname === "/reset") {
        // 履歴を最初の「しりとり」だけの状態に戻す
        wordHistory = ["しりとり"];

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
