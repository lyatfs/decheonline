# Hướng dẫn chạy máy chủ LAN (4 người chơi) — AoE1 Web

Tài liệu này hướng dẫn cách tự chạy bản build production của **AoE1 Web** trên máy cá nhân để 2–4 người cùng chơi qua mạng nội bộ (LAN / Wi-Fi).

> **Lưu ý tích hợp:** Phần cấu hình chi tiết, bảo mật token và xử lý sự cố cho tunnel qua Internet (opt-in) xem thêm tại [`docs/multiplayer4-tunnel.md`](./multiplayer4-tunnel.md), và danh sách kiểm tra bàn giao tại [`docs/multiplayer4-acceptance.md`](./multiplayer4-acceptance.md).

---

## 1. Phân biệt Máy chủ vật lý và Chủ phòng (`hostSlot`)

Hai khái niệm sau hoàn toàn khác nhau — cần phân biệt rõ trước khi mở phòng:

| Khái niệm | Ý nghĩa | Khi người đó thoát / mất kết nối |
|---|---|---|
| **Máy chủ vật lý (Physical Host)** | Máy tính chạy `Chay-May-Chu.cmd` (tiến trình Node.js phục vụ giao diện web, asset pack và WebSocket `/ws`). | **Toàn bộ phòng và trận đấu đang chạy bị dừng ngay lập tức.** Mọi người chơi sẽ mất kết nối vì không có cơ chế di chuyển tiến trình server sang máy khác. |
| **Chủ phòng (`hostSlot` / Room Host)** | Quyền điều khiển trong sảnh chờ (chọn sức chứa 2/4 người, chọn bản đồ, bấm Start). | Trong lobby, quyền `hostSlot` tự động chuyển cho slot còn kết nối nhỏ nhất (không đổi slot, màu hay văn minh). Trong trận, chủ phòng rời chỉ ảnh hưởng slot của người đó; trận vẫn tiếp tục bình thường chừng nào **Máy chủ vật lý** còn chạy. |

> **Cảnh báo quan trọng về giấc ngủ máy (Sleep) & đóng cửa sổ:**
> Không gập màn hình laptop, không để Windows tự Sleep/Hibernate, và **không đóng cửa sổ `Chay-May-Chu.cmd`** trong suốt thời gian bạn bè đang chơi. Nếu máy chủ vật lý ngủ hoặc tiến trình server bị tắt, mọi trận đấu sẽ bị ngắt.

---

## 2. Yêu cầu trước khi chạy

1. **Node.js >= 24** (khuyến nghị bản LTS 24.x trở lên).
2. **Bản build production** đã được biên dịch sẵn:
   - Server: `apps/server/dist/main.js`
   - Client: `apps/client/dist/index.html`
   - Nếu chưa có, chạy một lần tại thư mục gốc repo:
     ```powershell
     npm run build
     ```
3. **Asset pack hợp lệ** tại `assets-local/pack/manifest.json` (hoặc trỏ biến môi trường `ASSETS_DIR` tới thư mục pack).

Launcher **không** tự chạy `npm install`, **không** tự mở server dev Vite, và **không** tự thay đổi cấu hình Firewall/Router/DNS.

---

## 3. Khởi động, kiểm tra trạng thái và dừng máy chủ

### Cách 1: Chạy trực tiếp trên Windows
Nhấp đúp vào tệp **`Chay-May-Chu.cmd`** tại thư mục gốc của repo (hỗ trợ đường dẫn có dấu cách và ký tự Unicode tiếng Việt, chạy được từ bất kỳ thư mục làm việc nào).

Cửa sổ sẽ kiểm tra môi trường, khởi động máy chủ production và hiển thị:
- **Local URL**: `http://127.0.0.1:8787`
- **LAN URLs**: Ví dụ `http://192.168.1.25:8787` (địa chỉ IPv4 LAN thật, đã lọc bỏ loopback, link-local và adapter ảo như WSL/Docker/VPN)
- **Log file**: Đường dẫn tệp nhật ký (mặc định trong `assets-local/host-runtime/host-server.log`, tự xoay vòng và che token nhạy cảm)

Để dừng máy chủ an toàn, nhấn `Ctrl+C` trong cửa sổ đang chạy (hoặc đóng cửa sổ).

### Cách 2: Chạy bằng CLI (`tools/host/cli.ts`)

```powershell
# Kiểm tra điều kiện (Node >= 24, build, assets, cổng trống) mà chưa bật server
node tools/host/cli.ts preflight

# Bật ở chế độ foreground (Ctrl+C để dừng)
node tools/host/cli.ts start

# Bật chạy nền (detached) và trả về ngay khi server sẵn sàng
node tools/host/cli.ts start --detach

# Xem trạng thái và danh sách LAN URL hiện tại
node tools/host/cli.ts status

# Dừng đúng tiến trình server do launcher quản lý
node tools/host/cli.ts stop
```

### Tùy chọn cấu hình (CLI flags & Biến môi trường)

| Tùy chọn CLI | Biến môi trường | Mặc định | Ý nghĩa |
|---|---|---|---|
| `--port <port>` | `PORT` | `8787` | Cổng HTTP + WebSocket duy nhất |
| `--host <ip>` | `HOST` | `0.0.0.0` | Địa chỉ lắng nghe (`0.0.0.0` cho phép máy LAN kết nối) |
| `--interface <tên\|ip>` | `HOST_INTERFACE` | tự chọn | Chỉ định card mạng LAN ưu tiên nếu máy có nhiều IP |
| `--assets-dir <path>` | `ASSETS_DIR` | `assets-local/pack` | Thư mục chứa gói asset |
| `--client-dir <path>` | `CLIENT_DIR` | `apps/client/dist` | Thư mục chứa bản build client |
| `--public-url <url>` | `PUBLIC_URL` | *(trống)* | Origin công khai cố định (`http://` hoặc `https://`) |
| `--tunnel` | — | `false` | Bật (opt-in) tunnel chia sẻ qua Internet (chỉ chạy foreground, không dùng cùng `--detach`) |
| `--tunnel-provider <tên>` | — | `cloudflared` | Nhà cung cấp tunnel: `cloudflared`, `ngrok`, hoặc `custom` |
| `--tunnel-bin <path>` | — | theo `provider` | Đường dẫn tới tệp thực thi tunnel do bạn tự cài đặt |
| `--tunnel-token-file <path>` | — | *(trống)* | Tệp chứa token cho Named Tunnel (không truyền token trực tiếp vào URL mời hay log) |
| `--tunnel-name <tên>` | — | *(trống)* | Tên Named Tunnel (khi dùng tunnel cố định) |
| `--log-path <path>` | `HOST_LOG_PATH` | `assets-local/host-runtime/host-server.log` | Đường dẫn file log |
| `--json` | — | `false` | Xuất trạng thái JSON cho công cụ tự động |

---

## 4A. Chia sẻ qua Internet bằng Tunnel (Opt-In)

Mặc định launcher chỉ chạy mạng LAN. Nếu bạn muốn mời bạn bè **ngoài mạng LAN** vào chơi trực tiếp bằng link `https://.../?room=CODE` (cùng một origin phục vụ cả web UI, `/assets/*` và WebSocket `wss://.../ws`), bạn có thể bật tùy chọn `--tunnel` với binary `cloudflared` hoặc `ngrok` do chính bạn cài đặt sẵn:

```powershell
# Quick Tunnel (URL tạm thời, thay đổi mỗi lần khởi động lại)
node tools/host/cli.ts start --tunnel --tunnel-provider cloudflared

# Named Tunnel cố định với tệp token riêng và domain của bạn
node tools/host/cli.ts start --tunnel --tunnel-provider cloudflared --tunnel-token-file C:\secrets\cf-token.txt --public-url https://aoe.example.com
```

- **Tạm thời (`temporary`) vs. Cố định (`fixed`):** Quick Tunnel tạo URL mới mỗi lần chạy và lập tức hết hiệu lực khi bạn dừng launcher (`Ctrl+C`). Named Tunnel giữ domain cố định khi có `--public-url`.
- **Không tự tải binary / không dùng shell:** Launcher không tự tải `cloudflared`/`ngrok`, chỉ gọi đúng binary bạn cấu hình với `shell: false`, và tự che mọi token (`TUNNEL_TOKEN`, `Bearer`, `eyJ...`) trong log và thông báo lỗi.
- **Tài liệu đầy đủ:** Xem chi tiết quy trình, bảo mật token và kiểm tra ngoài LAN (`O07`–`O09`, `A09`) tại [`docs/multiplayer4-tunnel.md`](./multiplayer4-tunnel.md).

---

## 4. Các bước chơi qua mạng LAN (4 người)

1. **Chủ máy (Physical Host)** bật `Chay-May-Chu.cmd` và kiểm tra danh sách **LAN URLs** được in ra (ví dụ `http://192.168.1.25:8787`).
2. **Mở trình duyệt trên chính máy chủ bằng LAN URL** (`http://192.168.1.25:8787`) — *khuyến nghị không dùng `localhost` nếu bạn muốn bấm nút sao chép link mời ngay trong game để gửi cho máy khác*.
3. Tạo phòng Multiplayer, chọn sức chứa **4 người** (`capacity: 4`), chọn văn minh và bấm **Sao chép link mời** (dạng `http://192.168.1.25:8787/?room=ABCDE`).
4. **Ba người chơi còn lại** kết nối cùng mạng Wi-Fi / LAN, mở đúng link mời đó trên trình duyệt (không cần cài Node.js hay clone mã nguồn), nhập tên, chọn văn minh và bấm **Ready**.
5. Khi đủ 4 người Ready, **Chủ phòng (`hostSlot`)** bấm **Start**.

---

## 5. Mở Windows Defender Firewall thủ công (nếu máy khác không truy cập được)

Launcher **không bao giờ tự động chỉnh sửa Windows Firewall**. Nếu người chơi khác trong cùng mạng LAN không mở được `http://<LAN-IP>:8787`, máy chủ vật lý cần cho phép lưu lượng TCP vào cổng `8787` trên mạng **Private**:

### Cách A: Qua giao diện Windows Security
1. Mở **Windows Security** → **Firewall & network protection** → **Allow an app through firewall**.
2. Chọn **Change settings** → tìm **Node.js JavaScript Runtime** (hoặc bấm **Allow another app...** trỏ tới `node.exe`).
3. Chỉ đánh dấu cột **Private** (không khuyến nghị mở **Public** ở quán cà phê/mạng công cộng) → **OK**.

### Cách B: Qua PowerShell (chạy với quyền Administrator)
Mở PowerShell (Run as Administrator) và tạo rule chỉ cho mạng `Private` trên cổng đã chọn (mặc định `8787`):

```powershell
New-NetFirewallRule -DisplayName "AoE1 Web LAN Server (TCP 8787)" -Direction Inbound -Protocol TCP -LocalPort 8787 -Profile Private -Action Allow
```

Khi không muốn mở cổng nữa, bạn có thể gỡ rule bằng:

```powershell
Remove-NetFirewallRule -DisplayName "AoE1 Web LAN Server (TCP 8787)"
```

---

## 6. Xử lý sự cố thường gặp

- **`Port 8787 on 0.0.0.0 is already in use`**: Có chương trình khác đang dùng cổng `8787`. Launcher sẽ **không** tự tắt tiến trình lạ. Hãy đổi cổng bằng `Chay-May-Chu.cmd --port 8788` hoặc đặt `PORT=8788`.
- **`Built server entry not found` / `Built client entry not found`**: Chưa chạy `npm run build` tại thư mục gốc repo.
- **`Asset manifest not found`**: Thiếu `assets-local/pack/manifest.json`. Kiểm tra lại thư mục `assets-local/pack` hoặc đặt `ASSETS_DIR`.
- **Nhiều địa chỉ IP / có VPN (Tailscale, ZeroTier, WSL, Docker, VMware)**: Launcher tự lọc bỏ các adapter ảo phổ biến. Nếu bạn muốn chia sẻ qua một card mạng cụ thể (ví dụ `Ethernet` hoặc `Wi-Fi`), chạy:
  ```powershell
  node tools/host/cli.ts start --interface "Wi-Fi"
  ```
- **Kiểm tra PID khi dừng (`stop`)**: Launcher lưu PID kèm thời gian khởi chạy và câu lệnh để xác minh danh tính tiến trình trước khi dừng, tránh tắt nhầm chương trình khác nếu hệ điều hành tái sử dụng PID.
