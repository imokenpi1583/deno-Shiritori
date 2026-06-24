// server.js
import { serveDir } from "jsr:@std/http/file-server";

//直前の単語を保持しておく
let wordHistory = ["しりとり"];

const connectedClients = new Set();

// 全員にJSONデータを送るヘルパー関数
function broadcast(data) {
    const messageString = JSON.stringify(data);
    for (const client of connectedClients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(messageString);
        }
    }
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
            connectedClients.add(socket);
        };

        socket.onclose = () => {
            console.log("プレイヤー退場ッ！");
            connectedClients.delete(socket); // リストから削除
        };

        socket.onmessage = (event) => {
            const nextWord = event.data.trim();
            const previousWord = wordHistory[wordHistory.length - 1];

            //サーバー側でひらがな・カタカナ・長音チェック
            const regex = /^[ぁ-んァ-ヶー]+$/;
            if (!regex.test(nextWord)) {
                broadcast({
                    "type": "gameover",
                    "errorCode": "10004", // 新しいエラーコード
                    "errorMessage":
                        "ひらがな・カタカナ以外の不正な文字（記号や空白など）が入力されました！",
                });
                return;
            }

            if (wordHistory.includes(nextWord)) {
                broadcast({
                    "type": "gameover",
                    "errorCode": "10003",
                    "errorMessage": `「${nextWord}」はすでに使われています！`,
                });
                return;
            }

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
                previousEnd = smallToLarge[previousEnd]; // 「ぁ」から「あ」に化けさせる
            }

            //しりとり接続チェック
            if (previousEnd !== nextStart) {
                broadcast({
                    "type": "gameover",
                    "errorCode": "10001",
                    "errorMessage":
                        `「${nextWord}」は「${previousEnd}」に続いていません！`,
                });
                return;
            }

            //「ん」チェック
            if (nextWord.slice(-1) === "ん") {
                broadcast({
                    "type": "gameover",
                    "errorCode": "10002",
                    "errorMessage": `末尾が「ん」で終わっています！`,
                });
                return;
            }

            // すべてのチェックをクリアしたら履歴に追加
            wordHistory.push(nextWord);

            // 全員に新しい単語を通知
            broadcast({
                "type": "success",
                "word": nextWord,
            });
        };

        return response;
    }

    console.log(`pathname: ${pathname}`);

    // GET /shiritori: 直前の単語を返す
    if (_req.method === "GET" && pathname === "/shiritori") {
        const previousWord = wordHistory[wordHistory.length - 1];
        return new Response(previousWord);
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
