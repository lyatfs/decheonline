CHINESE SPEARMAN — 2.5D Pixel Art Game Assets

Gói tài nguyên gồm:
- spearman_china_atlas.png: sprite atlas trong suốt (1536 x 1024)
- atlas.json: thông tin bố cục, thứ tự frame và FPS tham khảo
- 40 frame PNG (RGBA), kích thước chuẩn 192 x 205 px/frame

Bố cục 8 cột x 5 hàng:
1. idle_directions: 8 góc nhìn đứng yên (KHÔNG phải 8 frame của cùng một animation)
2. move_east: 8 frame di chuyển sang phải
3. attack_thrust_east: 8 frame đâm giáo
4. attack_sweep_east: 8 frame vung/quét giáo
5. death_east: 8 frame trúng đòn và nằm xuống

Lưu ý: Frame được chia theo lưới và tạo tự động từ ảnh vẽ bằng AI. Vui lòng kiểm tra căn chỉnh chân/pivot, hitbox và sự khác biệt giữa các frame trước khi dùng trong dự án sản xuất. Bộ này CHƯA có chuyển động/tấn công đầy đủ 8 hướng.

PNG hỗ trợ alpha trong suốt. Ở engine, có thể load file PNG theo action rồi phát theo suggested_fps của atlas.json.
