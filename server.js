// server.js
import { serveDir } from "jsr:@std/http/file-server";

//直前の単語を保持しておく
let wordHistory = ["しりとり"];
let connectedClients = [];
let turnIndex = 0; // 現在何番目のプレイヤーのターンか（0または1）
let gameStarted = false;
let spectators = [];

// 全員にJSONデータを送るヘルパー関数
function broadcast(data) {
    connectedClients.forEach((client, index) => {
        if (client.readyState === WebSocket.OPEN) {
            const isYourTurn = index === turnIndex;
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

// localhostにDenoのHTTPサーバーを展開
Deno.serve(async (_req) => {
    // パス名を取得する
    // http://localhost:8000/hoge に接続した場合"/hoge"が取得できる
    const pathname = new URL(_req.url).pathname;

    if (pathname === "/shiritori-ws") {
        const { response, socket } = Deno.upgradeWebSocket(_req);

        socket.onopen = () => {
            console.log("プレイヤー参戦！");
            // 3人目以降の接続は一旦拒否
            if (connectedClients.length >= 2) {
                spectators.push(socket);
                console.log(
                    `観戦者が増えました。現在の観戦者数: ${spectators.length}`,
                );

                socket.send(JSON.stringify({
                    "type": "spectate_start",
                    "role": "spectator",
                    "word": wordHistory[wordHistory.length - 1],
                    "recentWords": wordHistory.slice(-5),
                    "message": "満員のため観戦モードで参加中",
                }));
                return;
            }

            connectedClients.push(socket);

            if (connectedClients.length === 1) {
                gameStarted = false;
                socket.send(JSON.stringify({
                    "type": "waiting",
                    "role": "player",
                    "message": "対戦相手を待っています...",
                }));
            } else if (connectedClients.length === 2 && !gameStarted) {
                gameStarted = true;

                //先攻後攻をランダムで決める
                turnIndex = Math.floor(Math.random() * 2);
                console.log(
                    `ゲーム開始！先攻プレイヤーのインデックス: ${turnIndex}`,
                );

                // 全員にゲーム開始の個別データを送る
                broadcast({
                    "type": "game_start",
                    "word": wordHistory[wordHistory.length - 1],
                    "recentWords": wordHistory.slice(-5),
                });
            }
        };

        socket.onclose = () => {
            console.log("プレイヤー退場ッ！");
            connectedClients = connectedClients.filter((client) =>
                client !== socket
            );
            if (connectedClients.length < 2) {
                turnIndex = 0;
                gameStarted = false;

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

        socket.onmessage = (event) => {
            //手番プレイヤーからの送信かチェック
            const currentPlayerSocket = connectedClients[turnIndex];
            if (socket !== currentPlayerSocket) {
                // 自分のターンじゃない奴からのメッセージは無視する
                return;
            }

            const nextWord = event.data.trim();

            // 重複チェック
            if (wordHistory.includes(nextWord)) {
                //敗者に送る
                socket.send(JSON.stringify({
                    "type": "gameover",
                    "result": "lose",
                    "role": "player",
                    "errorMessage": `「${nextWord}」はすでに使われています！`,
                }));

                //勝者,観戦者に送る
                broadcast({
                    "type": "gameover",
                    "result": "win", // 自分以外はみんな勝ち（または終了）扱い
                    "errorMessage":
                        `プレイヤーが「${nextWord}」という重複した単語を使いました！`,
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
                //敗者に送る
                socket.send(JSON.stringify({
                    "type": "gameover",
                    "result": "lose",
                    "errorMessage":
                        `「${nextWord}」は「${previousEnd}」に続いていません！`,
                }));

                //勝者、観戦者に送る
                broadcast({
                    "type": "gameover",
                    "result": "win",
                    "errorMessage":
                        `プレイヤーが「${previousEnd}」に続かない単語を入力しました！`,
                });
                return;
            }

            // 「ん」チェック
            if (toHiragana(nextWord.slice(-1)) === "ん") {
                //敗者に送る
                socket.send(JSON.stringify({
                    "type": "gameover",
                    "result": "lose",
                    "errorMessage": `末尾が「ん」で終わっています！`,
                }));

                //勝者、観戦者に送る
                broadcast({
                    "type": "gameover",
                    "result": "win",
                    "errorMessage":
                        `プレイヤーが「ん」のつく単語を入力しました！`,
                });
                return;
            }

            // 全てのチェックをクリアしたら履歴に追加
            wordHistory.push(nextWord);
            const recentWords = wordHistory.slice(-5);

            // 2. 次のプレイヤーにターンを譲る
            // 2人対戦なら 0 ➔ 1 ➔ 0 ➔ 1 と交互に入れ替わる
            turnIndex = (turnIndex + 1) % connectedClients.length;

            //正しいJSONデータ形式で全員に一斉送信
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
