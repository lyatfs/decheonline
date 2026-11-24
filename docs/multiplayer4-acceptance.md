# Nghiệm Thu Thực Địa & Bàn Giao Vận Hành — Multiplayer 4 Người (`mp4-v1`)
# Field Acceptance & Operator Handover — 4-Player Multiplayer (`mp4-v1`)

> **Trạng thái hiện tại / Current Gate Status:**
> Toàn bộ các bài kiểm thử chạy thực thi dài hạn và thực địa (**`A06`, `A07`, `A08`, `A09`, `O09`**) đều đang ở trạng thái **`DEFERRED / NOT RUN (BLOCKED pending live hardware/runtime execution)`**.
> Tài liệu này cung cấp hướng dẫn vận hành chuẩn cho chủ máy Windows, phân biệt rạch ròi vai trò máy chủ vật lý và chủ phòng (`hostSlot`), cùng bảng nghiệm thu & biểu mẫu bằng chứng để hoàn tất kiểm chứng thực địa khi có đủ phần cứng và mạng ngoài.
> **Không được sử dụng** lệnh 2-player cũ (`npm run test:soak` / `e2e/playwright.soak.config.ts`) để thay thế hoặc tuyên bố đạt cho kiểm thử soak 4 người (`A06`).

---

## 1. Phân Biệt Hai Khái Niệm Host / Physical Host vs. Room Host (`hostSlot`)

| Tiêu chí / Aspect | **Máy Chủ Vật Lý (Physical Host)** | **Chủ Phòng (Room Host — `hostSlot`)** |
|---|---|---|
| **Bản chất / Definition** | Máy tính Windows đang chạy tiến trình Node production (`apps/server`) và (tùy chọn) tiến trình tunnel (`cloudflared`). | Vai trò điều khiển lobby (`slot` `0..3`) của một người chơi đang kết nối trong phòng. |
| **Quyền hạn / Authority** | Giữ toàn bộ `RoomRegistry`, cấp phát/phát hành `turn`, lưu trữ `MatchManifest`, phục vụ HTTP UI + `/assets/*` + WebSocket `/ws` trên một cổng duy nhất. | Chỉ được phép đổi **Game Settings** (khi chưa Ready) và bấm **Start** (khi đủ `capacity` người chơi đã Ready và khớp phiên bản). |
| **Khi rời/ngắt kết nối / On Leave or Disconnect** | Nếu tắt server, đóng cửa sổ launcher hoặc máy Windows ngủ/ngủ đông (**Sleep/Hibernate**), **toàn bộ các trận đang chạy trên máy đó dừng ngay lập tức**. | Nếu chủ phòng rời lobby, server tự chuyển `hostSlot` sang slot người chơi còn kết nối nhỏ nhất (`0..3`). Trong trận đang chơi, việc đổi `hostSlot` **không** chuyển tiến trình server (không có live server migration) và **không** mở khóa quyền pause/tốc độ single-player. |
| **Ảnh hưởng tới định danh / Identity Impact** | Không gắn với `slot` hay màu quân; người vận hành có thể mở trình duyệt trên chính máy chủ vật lý để tham gia như một client bình thường. | Chuyển `hostSlot` **không** làm đổi `slot`, `playerId` (`slot + 1`), màu quân (`owner 1..4`), đơn vị đã sở hữu hay `rejoin` token của bất kỳ ai. |

---

## 2. Hướng Dẫn Nhanh Cho Chủ Máy Windows / Quick-Start Guide (Windows Host)

### 2.1. Điều kiện tiên quyết / Prerequisites
1. **Node.js `>= 24`** đã cài đặt trên máy Windows.
2. **Bản build production** đã được biên dịch sẵn (không dùng `vite dev` để chia sẻ cho bạn bè):
   ```powershell
   npm run build
   ```
3. **Bộ asset pack hợp lệ** đã được import (chứa đủ biến thể màu `owner 1..4` cho các graphic sử dụng thực tế; xem `/api/health`):
   ```powershell
   $env:AOE1_DIR = "D:\Path\To\AoE1"
   npm run assets:import
   ```

### 2.2. Khởi động máy chủ cho mạng LAN / Starting Server for LAN
*(Chi tiết đầy đủ tham số CLI và adapter tunnel xem thêm tại `docs/multiplayer4-hosting.md` và `docs/multiplayer4-tunnel.md`; CLI flags gồm `preflight`, `start`, `status`, `stop` qua `node tools/host/cli.ts`.)*
1. Tại thư mục gốc repo (hỗ trợ đường dẫn có dấu cách hoặc ký tự Unicode, không phụ thuộc thư mục làm việc hiện tại của shell), nhấp đúp hoặc chạy:
   ```powershell
   .\Chay-May-Chu.cmd
   ```
   *(Hoặc chạy qua CLI host launcher trong `tools/host` với các biến môi trường chuẩn: `HOST`, `PORT` mặc định `8787`, `ASSETS_DIR`, `CLIENT_DIR`, `PUBLIC_URL`).*
2. Kiểm tra trạng thái sẵn sàng của server production:
   - `GET http://127.0.0.1:8787/api/health` phải trả **`200`** và `status: "ready"`.
   - `GET http://127.0.0.1:8787/api/versions` trả về JSON `CompatibilityVersions` (`protocol: "mp4-v1"`, `rules: "sim-v1"`, `build`, `assets`).
3. **Chọn đúng địa chỉ IP LAN (LAN IP Selection)**:
   - Launcher liệt kê các địa chỉ IPv4 LAN khả dụng. Nếu máy có nhiều card mạng (Wi-Fi, Ethernet, VPN, WSL, Hyper-V, Tailscale), hãy chọn **đúng IP của mạng Wi-Fi/Ethernet nội bộ** mà 3 máy kia đang kết nối (ví dụ `192.168.1.x`).
   - **Tuyệt đối không** gửi `http://localhost:8787` hoặc `http://127.0.0.1:8787` cho máy khác.
4. **Tạo phòng 4 người và chia sẻ link mời / Create 4-Player Room & Share Invite Link**:
   - Mở trình duyệt trên máy chủ theo `http://<LAN_IP>:<PORT>/` (hoặc `http://127.0.0.1:<PORT>/` cho chính chủ máy).
   - Nhập tên, chọn sức chứa **4 người (Capacity = 4)**, bấm **Tạo phòng (Create)**.
   - Sao chép link mời dạng:
     ```text
     http://<LAN_IP>:<PORT>/?room=<CODE>
     ```
   - Ba người bạn mở link trên trình duyệt (không cần clone code, không cần cài Node), nhập tên, chọn văn minh (`civ`), bấm **Ready**. Khi đủ 4/4 người Ready, chủ phòng bấm **Start**.
   - **Bảo mật link mời**: Link mời chỉ chứa `?room=<CODE>`, tuyệt đối **không** chứa reconnect token, bot token, hay tunnel token.

### 2.3. Chia sẻ qua Internet bằng Tunnel (Opt-in Internet Tunnel Sharing)
Tính năng tunnel là **tùy chọn (opt-in)** và không tự động tải binary không rõ nguồn hoặc tự ý sửa firewall/router:
1. Người dùng tự cài `cloudflared` chính thức và (nếu dùng tunnel cố định) tự cấu hình tài khoản/token của mình.
2. Bật chế độ tunnel trong launcher. Launcher chỉ truyền tham số an toàn cho binary đã cấu hình (không `shell-eval`, tự che token trong log).
3. Phân biệt rõ hai loại URL public (`publicUrlKind`):
   - **Tunnel tạm (`temporary` / Quick Tunnel)**: Tạo URL `https://*.trycloudflare.com` tạm thời; URL **sẽ đổi mỗi lần khởi động lại** và mất hiệu lực ngay khi tắt tunnel. Không cam kết đây là URL cố định.
   - **Tunnel cố định (`fixed` / Named Tunnel)**: Dùng domain cố định do người dùng cấu hình (`PUBLIC_URL`).
4. Khi dùng tunnel:
   - Link mời cho khách ngoài LAN phải dùng origin HTTPS của tunnel: `https://<tunnel-domain>/?room=<CODE>`.
   - Client tự động kết nối WebSocket cùng origin qua TLS (`wss://<tunnel-domain>/ws`).
   - Ghi chú quan trọng: Không tắt máy, không để Windows vào chế độ Sleep trong suốt thời gian chơi.

### 2.4. Dừng máy chủ và tunnel an toàn / Stopping Server & Tunnel Safely
- Luôn dùng nút/lệnh **Stop** của launcher (hoặc nhấn `Ctrl+C` trong cửa sổ terminal của `Chay-May-Chu.cmd` và chờ tiến trình thoát gọn).
- Launcher chỉ dừng **đúng cây tiến trình con (PID/process tree) do chính launcher tạo ra** (có kiểm tra định danh PID tránh tái sử dụng PID). Không bao giờ tự ý `taskkill` toàn bộ `node.exe` hoặc `cloudflared.exe` đang chạy của tác vụ khác.
- Sau khi dừng tunnel, mọi link Internet tạm thời sẽ hết hiệu lực ngay lập tức.

---

## 3. Xử Lý Sự Cố Thường Gặp / Common Error Recovery

| Triệu chứng / Mã lỗi | Nguyên nhân có thể | Cách khắc phục chuẩn (Operator Action) |
|---|---|---|
| **Port busy (`EADDRINUSE`)** | Cổng `8787` (hoặc `PORT` cấu hình) đang bị tiến trình khác chiếm dụng hoặc launcher cũ chưa dừng hẳn. | Kiểm tra xem đã có một cửa sổ server đang mở chưa; nếu muốn chạy song song hoặc đổi cổng, đặt `PORT=8788` (ví dụ `set PORT=8788 && .\Chay-May-Chu.cmd`). Launcher không tự động kill tiến trình lạ. |
| **Missing build / HTTP 404 tại `/`** | Chưa chạy `npm run build` nên thiếu `apps/client/dist` hoặc `apps/server/dist`. | Dừng server, chạy `npm run build` tại thư mục gốc repo, rồi khởi động lại launcher. |
| **`/api/health` trả `503 not-ready`** | Thiếu thư mục `ASSETS_DIR`, thiếu file trong pack, hoặc thiếu biến thể màu `owner 1..4` cho graphic sử dụng trong game. | Kiểm tra đường dẫn `ASSETS_DIR` (mặc định `assets-local/pack`), chạy lại `AOE1_DIR=<install> npm run assets:import` và kiểm tra báo cáo từ `multiplayer-audit`. Không dùng synthetic pack để tuyên bố art thật sẵn sàng. |
| **Lỗi `version-mismatch` khi Join/Ready/Start** | Client và server khác `protocol`, `rules`, `build`, hoặc `assets` fingerprint (ví dụ trình duyệt khách đang giữ cache JS cũ). | Yêu cầu client tải lại trang mạnh (**Ctrl + Shift + R**). Kiểm tra `/api/versions` trên server; đảm bảo toàn bộ server/client vừa được build cùng phiên bản. |
| **Khách LAN mở link bị timeout / không tải được trang** | Sai IP LAN (gửi nhầm `localhost` hoặc IP card mạng ảo VPN/WSL), hoặc Windows Firewall đang chặn kết nối đến cổng `8787`. | Kiểm tra lại IP LAN đúng của Wi-Fi/Ethernet. Nếu do Windows Firewall, chủ máy mở thủ công *Windows Defender Firewall -> Inbound Rules -> New Rule -> Port TCP `8787` -> Allow on Private networks* (launcher không tự sửa firewall với quyền Admin). |
| **`room-full` / `room-started` / `bad-code`** | Phòng đã đủ 4 người (người thứ 5 bị từ chối), trận đã bắt đầu (không nhận join muộn), hoặc mã phòng sai/đã đóng. | Kiểm tra mã phòng 5 ký tự. Nếu phòng đang chơi, tạo phòng mới. Giao diện vẫn giữ nguyên tên đã nhập để người chơi thử lại. |
| **Lỗi `bad-rejoin` / bị drop giữa trận** | Kết nối rớt quá thời hạn chờ `DROP_AFTER_MS` (`120.5` giây) hoặc server đã bị tắt/restart. | Người chơi bị drop sẽ được server tự động `resign` đúng lượt; **các người chơi còn lại vẫn tiếp tục trận bình thường**. Nếu server vật lý bị tắt, cần mở lại server và tạo trận mới. |
| **Tunnel lỗi / không ra public URL** | Chưa cài `cloudflared`, mất mạng Internet, hoặc token tunnel sai/hết hạn. | Kiểm tra log của launcher (token đã được che). Xác nhận lệnh `cloudflared --version` hoạt động và thử khởi động lại tunnel. |

---

## 4. Bảng Nghiệm Thu Bắt Buộc (`A06`–`A09`, `O09`) / Acceptance Checklist

> **Lưu ý:** Tất cả các gate dưới đây hiện ở trạng thái **`DEFERRED / NOT RUN (BLOCKED pending live hardware/runtime execution)`**. Chỉ đánh dấu `PASS` sau khi chạy thực tế trên đúng môi trường mục tiêu và điền đầy đủ bằng chứng ở Mục 5.

| Test ID | Hạng mục / Scope | Trạng thái / Status | Lệnh chạy chính xác / Exact Run Command | Điều kiện bắt buộc để đạt / Pass Criteria |
|---|---|---|---|---|
| **A06** | **Seeded Soak 4 người** (3 seed cố định, 20 phút game/seed, lệnh 4 phía, drop/rejoin cưỡng bức, resign/loại người vẫn chơi tiếp, chu kỳ tạo trận mới) | **DEFERRED / NOT RUN** *(BLOCKED pending live hardware/runtime execution)* | `cd e2e && npx playwright test -c playwright.multiplayer4-soak.config.ts --grep "A06"` *(hoặc chạy toàn bộ file config soak4)* | 0 desync, 0 stall/leak qua đủ 3 seed (`20260401`, `20260402`, `20260403`). Nếu có lỗi, log phải in rõ `seed`, `firstDivergentTurn`, hash từng slot và `command trace`. **Không** dùng `npm run test:soak` (2-player) thay thế. |
| **A07** | **Cross-engine Determinism 4** (cùng replay 4 người chạy trên Node, Chromium, Firefox, WebKit) | **DEFERRED / NOT RUN** *(BLOCKED pending live hardware/runtime execution)* | `cd e2e && npx playwright test -c playwright.multiplayer4-soak.config.ts --grep "A07"` | Mảng hash theo từng turn trên mọi engine đã chạy khớp bit-for-bit với Node (V8). Engine nào thiếu binary hoặc không thể khởi chạy trên OS hiện tại phải được ghi chú tách biệt trong log/báo cáo (không im lặng bỏ qua). |
| **A08** | **4 Thiết Bị Thật Trên Mạng LAN** (tối thiểu 4 thiết bị vật lý tách biệt, không phải 4 tab localhost) | **DEFERRED / NOT RUN** *(BLOCKED pending live hardware/runtime execution)* | Chạy server production qua `.\Chay-May-Chu.cmd`, mở `http://<LAN_IP>:<PORT>/?room=<CODE>` trên 3 thiết bị LAN khác + 1 trình duyệt host | Cả 4 thiết bị tải đầy đủ UI/assets thật (màu `owner 1..4`), vào đúng phòng qua link LAN, Ready/Start, chơi đồng bộ không desync; thử 1 người resign/đóng tab và xác nhận 3 người còn lại tiếp tục bình thường; ghi nhận tài nguyên CPU/RAM/băng thông quan sát được. |
| **A09** | **Nghiệm Thu Internet Ngoài LAN & Bàn Giao** (tối thiểu 1 client nằm ngoài mạng LAN qua tunnel HTTPS + đóng/mở server & tunnel) | **DEFERRED / NOT RUN** *(BLOCKED pending live hardware/runtime execution)* | Bật server production + tunnel opt-in (`Chay-May-Chu.cmd` / `tools/host`), gửi `https://<tunnel-origin>/?room=<CODE>` cho client ngoài LAN | Client ngoài LAN vào phòng qua HTTPS, chơi đồng bộ; tắt tunnel hoặc tắt server đều hiển thị lỗi mất kết nối rõ ràng trên client; tài liệu bàn giao khởi chạy/chia sẻ/dừng/xử lý lỗi được xác nhận đầy đủ. |
| **O09** | **Kết Nối HTTPS + WebSocket + Reconnect Qua Tunnel Thật** | **DEFERRED / NOT RUN** *(BLOCKED pending live hardware/runtime execution)* | Kết hợp cùng bài chạy **A09**: ngắt mạng tạm thời trên client ngoài LAN (< `120.5s`) rồi nối lại | WebSocket `wss://<tunnel-origin>/ws` kết nối thành công; link `?room=<CODE>` hoạt động; client ngoài LAN rớt mạng tạm thời tự `rejoin` về đúng `slot`/`playerId`, nhận bù các turn thiếu và đồng bộ lại hash với 3 người còn lại. |

---

## 5. Biểu Mẫu Ghi Nhận Bằng Chứng Nghiệm Thu / Field Evidence Template

> Điền biểu mẫu này khi thực hiện chạy thực địa (`A06`–`A09`, `O09`). **Không suy đoán sức chứa từ cấu hình máy — chỉ ghi số liệu quan sát trực tiếp.**

### 5.1. Thông tin phiên bản & môi trường / Version & Host Environment
- **Ngày giờ thực hiện (UTC/Local):** `[TBD]`
- **Người thực hiện (Operator):** `[TBD]`
- **Git commit SHA:** `[TBD]`
- **Versions (`/api/versions`):**
  - `protocol`: `[TBD — expected mp4-v1]`
  - `rules`: `[TBD — expected sim-v1]`
  - `build`: `[TBD]`
  - `assets`: `[TBD]`
- **Máy chủ vật lý (Physical Host):** CPU `[TBD]`, RAM `[TBD]`, OS `[TBD]`, Node version `[TBD]`, Asset source (`assets-local/pack` hay synthetic) `[TBD]`

### 5.2. Kết quả Soak 4 (`A06`) & Cross-Engine Determinism 4 (`A07`)
- **Lệnh chạy thực tế:** `[TBD]`
- **Exit code:** `[TBD]`
- **Seeds đã chạy (`SOAK4_SEEDS`):** `[TBD — default 20260401, 20260402, 20260403]`
- **Tổng thời gian game (phút) & thời gian thực (wall time):** `[TBD]`
- **Drop/Rejoin & Resign continuation trong soak4:** `[PASS / FAIL — ghi chú]`
- **Engines đã kiểm tra cho `A07`:** Node `[ ]`, Chromium `[ ]`, Firefox `[ ]`, WebKit `[ ]`
- **Engine thiếu / bị bỏ qua (nếu có):** `[TBD]`
- **First divergent turn / hash / log path (nếu có lỗi):** `[TBD]`

### 5.3. Ma trận thiết bị LAN thật (`A08`) & Internet ngoài LAN (`A09` / `O09`)

| Slot | Thiết bị / OS / Trình duyệt | Mạng (LAN IP / Ngoài LAN ISP-4G) | RTT trung bình (ms) | FrameMs trung bình (ms) | Tải UI/Assets/Màu owner | Kết quả Reconnect (`O09`) | Ghi chú |
|---|---|---|---|---|---|---|---|
| 0 | `[TBD]` | `[Host / LAN]` | `[TBD]` | `[TBD]` | `[ ]` | `[N/A or PASS/FAIL]` | `[TBD]` |
| 1 | `[TBD]` | `[LAN]` | `[TBD]` | `[TBD]` | `[ ]` | `[ ]` | `[TBD]` |
| 2 | `[TBD]` | `[LAN]` | `[TBD]` | `[TBD]` | `[ ]` | `[ ]` | `[TBD]` |
| 3 | `[TBD]` | `[LAN or External Internet]` | `[TBD]` | `[TBD]` | `[ ]` | `[ ]` | `[TBD]` |

### 5.4. Quan sát tài nguyên máy chủ & sự cố / Observed Resources & Issues
- **CPU % quan sát được khi chạy trận 4 người:** `[TBD]`
- **RAM (MB) tiến trình `node` (+ `cloudflared` nếu bật):** `[TBD]`
- **Băng thông mạng ước lượng (KB/s up/down):** `[TBD]`
- **Hành vi khi đóng tab chủ phòng vs. tắt tiến trình server / tắt tunnel:** `[TBD]`
- **Lỗi phát sinh & file log (`tools/host` log path / Playwright artifacts):** `[TBD]`
- **Kết luận nghiệm thu thực địa:** **`BLOCKED / DEFERRED`** *(chuyển thành `PASS` hoặc `FAIL` chỉ sau khi hoàn tất toàn bộ A06–A09 & O09)*
