# mech-kb OCR 懒人包

一站式 OCR 管线：**本地 GLM-OCR 引擎 + tesseract 兜底 + KB 知识库**，下载即用，一键部署一键启动。

## 这是什么

本包集成了：
- **Ollama 便携版**（免安装，40MB）
- **GLM-OCR 模型**（2.7GB，0.9B 参数，MIT 协议，中文扫描版识别 SOTA）
- **tesseract.js**（本地 WASM，兜底引擎，含 chi_sim 训练数据）
- **mech-kb 知识库**（Web 界面 + HTTP API + OCR 管线 + 任务系统）

所有引擎本地运行，零 token 消耗。识别扫描版 PDF 的流程：初步 OCR → 质量一审 → 精确提取 → 常识三审 → 入库排任务。

## 目录结构

```
mech-kb-ocr-pack/
├── deploy.cmd / deploy.ps1      # 首次部署: 装依赖 + 验证 + 备训练数据
├── start.cmd  / start.ps1       # 一键启动: Ollama + Studio(端口7350)
├── stop.cmd   / stop.ps1        # 一键停止所有服务
├── ocr-test.cmd / ocr-test.ps1  # 引擎自检
├── .state.template/ocr.json     # 凭证模板(本地引擎无需填)
├── ollama/                      # Ollama 便携版
│   └── ollama.exe
├── models/                      # glm-ocr 模型权重
├── tessdata/                    # tesseract chi_sim 训练数据
└── kb/                          # mech-kb 知识库代码
    ├── automation/ocr.js        #   OCR 管线(四步: 初提→一审→精提→三审)
    ├── engines/ocr-engines.js   #   引擎统一接口(增删引擎零改KB)
    ├── core/                    #   状态机 + LLM + 操作表
    ├── runner/                  #   CLI 运行器
    ├── bin/mech-kb.js           #   统一入口
    ├── studio/                  #   Web 界面 + HTTP 服务
    └── package.json
```

## 系统要求

- **Windows 10/11 64 位**
- **Node.js 18+**（仅部署时需要，部署后可卸载）
- **GPU 可选**：有 NVIDIA GPU 约 2 秒/页；纯 CPU 约 8-15 秒/页（仍可用）
- **磁盘空间**：约 3.5GB（解压后）

## 使用步骤

### 第一步：部署（仅首次）

双击 `deploy.cmd`。脚本会：
1. 检查 Node.js
2. 安装 KB 依赖（npm，走国内 npmmirror 源）
3. 复制凭证模板
4. 验证 Ollama 与 glm-ocr 模型文件
5. 下载 tesseract 训练数据（约 15MB）

### 第二步：启动

双击 `start.cmd`。脚本会：
1. 后台启动 Ollama（GLM-OCR 引擎）
2. 后台启动 mech-kb Studio（Web 界面，端口 7350）
3. 自动打开浏览器 `http://localhost:7350`

启动后可看到知识库的「信源 / 任务 / 进度」页面。在信源页对扫描版 PDF 点 **OCR** 按钮即可触发管线。

### 第三步：验证（可选）

双击 `ocr-test.cmd`，跑引擎自检，确认：
- Ollama 连通 + glm-ocr 模型可用
- engines 接口加载正常
- GLM-OCR（主引擎）+ tesseract（兜底）就绪

### 停止

关闭 start.cmd 窗口，或运行 `stop.cmd`，停止所有后台服务。

## 引擎说明

| 引擎 | 类型 | 优先级 | 凭证 | 说明 |
|---|---|---|---|---|
| **GLM-OCR** | 本地 | 1（首选） | 无需 | 智谱 0.9B，OmniDocBench 榜首，中文/表格/公式强 |
| Doc2X | 云端 | 2（备选） | 需填 token | 每天 500 页免费（新账号需充值） |
| TextIn | 云端 | 3（备选） | 需填 app_id | ¥0.05/页 |
| tesseract | 本地 | 4（兜底） | 无需 | WASM，零依赖，质量一般 |

OCR 管线自动按优先级选择可用引擎。本地 GLM-OCR 足够覆盖绝大多数中文扫描版手册。

### 凭证配置（可选）

仅使用本地 GLM-OCR 无需任何凭证。若要启用云端备选引擎，编辑 `kb\.state\ocr.json`：

```json
{
  "ollama_url": "http://127.0.0.1:11434",
  "ollama_model": "glm-ocr",
  "doc2x_token": "你的 Doc2X token（可选）",
  "textin_app_id": "你的 TextIn app_id（可选）",
  "textin_secret_code": "你的 TextIn secret（可选）"
}
```

## 常见问题

**Q: 启动后打不开 http://localhost:7350**
A: 端口可能被占用。运行 `stop.cmd` 停掉旧进程，或检查 7350 端口占用：`netstat -ano | findstr 7350`

**Q: Ollama 启动失败**
A: 确认 `ollama\ollama.exe` 存在；如有防火墙提示，允许访问。端口 11434 不能被占用。

**Q: OCR 很慢**
A: 首次识别会加载模型到显存（约 10 秒），之后每页约 2 秒（GPU）。纯 CPU 约 8-15 秒/页。

**Q: 内存占用高**
A: GLM-OCR 模型约 4.5GB 显存或内存。建议 16GB 以上内存。

**Q: 关掉窗口后服务还在跑**
A: `start.cmd` 关闭窗口会自动停止。若残留，运行 `stop.cmd` 强制清理。

**Q: 想更新 KB 代码**
A: 替换 `kb\` 目录即可。引擎（ollama/models/tessdata）不用动。

## 引擎与知识库解耦

KB 核心代码只依赖 `engines/ocr-engines.js` 的统一接口（`available()` + `recognize()`），不 import 任何具体引擎。增删引擎只改 `engines/` 目录，KB 零改动。分享知识库时不带引擎本体（ollama 2.7GB），接收方自行安装。
