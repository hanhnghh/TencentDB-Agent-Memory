# Thiết lập Agent Memory cho Codex Subscription

Tài liệu này hướng dẫn chạy Agent Memory trên máy local và kết nối nhiều project
với Codex CLI hoặc Codex extension trong VS Code. Lưu lượng model vẫn sử dụng
Codex subscription; Agent Memory không proxy request model của Codex.

## Kiến trúc local

```text
Codex CLI / VS Code extension
        │ lifecycle hooks
        ▼
Managed sidecar (127.0.0.1:8097)
        │
        ▼
MemoryCore (127.0.0.1:8420)
        │
        └── Memory Panel (127.0.0.1:8125)
```

- MemoryCore lưu và xử lý L0/L1/L2/L3 cùng Skills.
- Memory Panel quản lý Team, Agent, Task và xem dữ liệu memory.
- Managed sidecar nhận lifecycle hooks từ Codex, ghi hội thoại, recall memory và
  inject nội dung Skill phù hợp vào context của Codex.
- Mỗi máy có một sidecar dùng chung cho tất cả project trên máy đó.
- Mỗi project có file binding riêng tại `.codex/memory-binding.json`.

## 1. Chuẩn bị source trên máy mới

Clone fork chứa các thay đổi Agent Memory cần sử dụng:

```bash
git clone <URL_FORK_CUA_BAN>
cd tencentdb-fork-agent-memory
```

Nếu đang phát triển thay đổi local, phải commit và push trước; máy khác chỉ pull
được những commit đã có trên remote.

## 2. Cấu hình LLM cho MemoryCore

Tạo file môi trường:

```bash
cp deploy/global-images/.env.example deploy/global-images/.env
```

Điền tối thiểu:

```ini
MEMORY_LLM_BASE_URL=https://api.openai.com/v1
MEMORY_LLM_API_KEY=<api-key>
MEMORY_LLM_MODEL=<model-name>
```

Không commit `.env` hoặc API key vào Git.

## 3. Khởi động MemoryCore và Memory Panel

```bash
cd deploy/global-images
./start-memory-core.sh
./start-memory-hub.sh
```

Kiểm tra:

```text
Memory Panel: http://localhost:8125/
MemoryCore:   http://localhost:8420/health
```

`GET http://localhost:8420/` trả `Not found` là bình thường; health endpoint là
`/health`.

Với Codex subscription, không cần chạy container MemoryProxy. Codex sử dụng
managed sidecar chạy local bằng Node.js và `tsx`.

## 4. Tạo Team, Agent và Task

Mở `http://localhost:8125/`, sau đó tạo hoặc chọn:

1. Team đại diện cho phạm vi chia sẻ memory.
2. Agent đại diện cho danh tính/vai trò memory của Codex.
3. Task đại diện cho phạm vi công việc cần bind.

Ghi lại ba ID do backend tạo:

```text
team-...
agt-...
task-...
```

Agent trên Memory Hub không phải process thực thi. Nó là danh tính dùng để sở
hữu, phân quyền, ghi và recall memory/skills. Codex mới là agent thực thi.

## 5. Cài plugin Codex và managed sidecar

Thao tác này chỉ cần thực hiện một lần trên mỗi máy.

```bash
cd /absolute/path/to/tencentdb-fork-agent-memory/MemoryProxy
npm install
```

Export cấu hình kết nối trong terminal hiện tại:

```bash
export MEMORY_CORE_ENDPOINT="http://127.0.0.1:8420"
export MEMORY_CORE_SERVICE_TOKEN="local"
export MEMORY_HUB_USER_KEY="<user-key-cua-ban>"
```

Ý nghĩa:

- `MEMORY_CORE_ENDPOINT`: địa chỉ MemoryCore local.
- `MEMORY_CORE_SERVICE_TOKEN`: token service dùng giữa sidecar và MemoryCore.
- `MEMORY_HUB_USER_KEY`: user key đăng nhập/quản lý trên Memory Panel.

Cài plugin và khởi động sidecar:

```bash
npm run codex -- install \
  --project "/absolute/path/to/project-dau-tien" \
  --config "$PWD/config.yaml"
```

Lệnh sẽ in ra SHA-256 của hook. Sau khi kiểm tra hook definition, trust chính
xác SHA đó:

```bash
npm run codex -- trust \
  --hooks-sha "<SHA-256-tu-lenh-install>"
```

Kiểm tra installation:

```bash
npm run codex -- doctor \
  --project "/absolute/path/to/project-dau-tien"
```

Kết quả mong đợi bao gồm plugin enabled/trusted, sidecar reachable và
MemoryCore reachable.

## 6. Bind một project

Chạy lệnh từ thư mục `MemoryProxy`, không chạy từ project đích nếu project đó
không có `package.json` chứa script `codex`.

```bash
cd /absolute/path/to/tencentdb-fork-agent-memory/MemoryProxy

npm run codex -- bind \
  --project "/absolute/path/to/project-moi" \
  --service-id "default" \
  --team-id "team-..." \
  --agent-id "agt-..." \
  --task-id "task-..."
```

Binding thành công sẽ tạo:

```text
/absolute/path/to/project-moi/.codex/memory-binding.json
```

Kiểm tra:

```bash
npm run codex -- status \
  --project "/absolute/path/to/project-moi"
```

Sau đó mở project đích trong VS Code hoặc terminal và tạo một Codex thread mới.

## 7. Thêm project khác trên cùng máy

Không cần:

- khởi động thêm Docker container;
- cài lại plugin;
- chạy thêm một sidecar;
- cấp một port mới.

Chỉ tạo Team/Agent/Task phù hợp trên Panel nếu cần, rồi chạy lại lệnh `bind` với
đường dẫn project mới. Sidecar tại `127.0.0.1:8097` tự resolve binding dựa trên
`cwd` của hook.

## 8. Cập nhật sidecar sau khi sửa MemoryProxy

Sidecar hiện chạy TypeScript trực tiếp bằng `tsx`, vì vậy không cần tạo thư mục
`dist` hoặc chạy `npm run build`.

Sau khi sửa source, cài lại package và restart managed sidecar:

```bash
cd /absolute/path/to/tencentdb-fork-agent-memory/MemoryProxy

npm run codex -- upgrade \
  --project "/absolute/path/to/mot-project-da-bind" \
  --config "$PWD/config.yaml"
```

Nếu SHA hook thay đổi, kiểm tra rồi trust SHA mới:

```bash
npm run codex -- trust --hooks-sha "<SHA-256-moi>"
```

Cuối cùng mở Codex thread mới để tránh dùng session/cache cũ.

Nếu chạy MemoryProxy bằng Docker thay vì managed sidecar thì phải rebuild image
và recreate container. Quy trình đó không áp dụng cho Codex subscription local
được mô tả trong tài liệu này.

## 9. Kiểm tra runtime

Kiểm tra sidecar:

```bash
curl --fail --silent --show-error http://127.0.0.1:8097/health
```

Các trạng thái quan trọng:

```text
mode: hooks
listeners.hooks.ready: true
connectivity.memoryCore: ok
connectivity.tdai: ok
```

Khi gửi prompt trong project đã bind, luồng Skill đúng là:

```text
UserPromptSubmit
→ sidecar gọi /v3/skill/search
→ sidecar gọi /v3/skill/get
→ full Skill content được đưa vào additionalContext
→ Codex sử dụng context được inject
```

Xem request Skill trong log MemoryCore:

```bash
docker logs --since 10m tdai-memory-core
```

Tìm các dòng:

```text
POST /v3/skill/search status=200
POST /v3/skill/get status=200
```

## 10. Lỗi thường gặp

### `ENOENT ... project/package.json`

Bạn đã chạy `npm run codex` bên trong project đích. Hãy chạy lệnh từ thư mục
`MemoryProxy` và truyền project đích qua `--project`.

### Port `8097` đã được sử dụng

Thông thường managed sidecar đã chạy. Không khởi động thêm MemoryProxy container
hoặc thêm một sidecar khác trên cùng port. Kiểm tra:

```bash
curl http://127.0.0.1:8097/health
```

### Binding tồn tại nhưng không thấy L0

Kiểm tra lần lượt:

1. Plugin đã enabled và trusted.
2. Sidecar health thành công.
3. Codex thread được mở từ đúng project root.
4. Project có `.codex/memory-binding.json`.
5. Tạo thread mới sau khi bind hoặc upgrade.

### Không thấy Skill được sử dụng

Kiểm tra log có cả `/v3/skill/search` và `/v3/skill/get`. Log chứng minh Skill đã
được tìm và inject; việc model có áp dụng từng chỉ dẫn còn phụ thuộc mức độ phù
hợp của Skill với prompt và nội dung chỉ dẫn.

### Badge L1 lớn hơn số item đang hiển thị

Badge L1 là tổng toàn bộ lịch sử, trong khi danh sách L1 mặc định lọc theo 24 giờ
gần nhất. Mở bộ lọc thời gian và chọn khoảng dài hơn để xem các bản ghi cũ.
