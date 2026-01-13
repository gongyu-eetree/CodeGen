import React, { useState, useEffect, useRef, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { GoogleGenAI } from "@google/genai";

// -----------------------------------------------------------------------------
// System Instruction
// -----------------------------------------------------------------------------
const SYSTEM_INSTRUCTION = `
你是一名“在线嵌入式系统编程应用智能体（Board-to-Code Agent）”，目标是：用户选择开发板/核心芯片与编程语言后，系统提供该开发板的原理图或PCB Netlist解析结果（连接关系图），你需要据此自动生成外设初始化与驱动关键代码，并根据用户的功能需求组合成可编译、可运行、可验证的完整工程代码。

# 0) 总体工作方式与硬性约束
- 你必须以“可运行、可维护、可移植”为第一优先级。
- 你只能基于输入提供的芯片/板卡信息、连接关系、外设清单和用户需求做推断；任何缺失信息必须明确列为“阻塞项/待确认项”，同时给出默认假设与替代方案（保证尽量继续产出可用代码）。
- 输出代码必须遵循用户选择的语言与生态（例如：C + STM32CubeHAL；C + NXP MCUXpresso SDK；C/C++ + ESP-IDF；C/C++ + Arduino；Rust；MicroPython 等），并优先使用官方SDK与推荐驱动方式。
- **重点关注**：用户在 user_requirements.active_peripherals 中明确选中的外设必须被初始化和使用。未选中的外设若无依赖关系可忽略。

# 2) 你的任务（必须全部完成）
A. 解析连接关系：把每条外设总线/IO映射成“可代码化的外设配置表”，识别冲突与缺失。
B. 生成“外设级关键代码”：对每个外设设备输出初始化、基本读写API、最小自检例程。
C. 生成“系统级可运行工程”：main(), drivers/, board_support/, app/。
D. 生成“集成说明与验证步骤”。

# 3) 输出格式（强制）
请严格按以下结构输出（不要省略标题），直接使用Markdown格式。

## Ⅲ. 完整工程骨架（可编译可运行）
- 目录结构树
- 关键文件内容...
`;

// -----------------------------------------------------------------------------
// Default Input Data
// -----------------------------------------------------------------------------
const DEFAULT_INPUT_JSON = {
  board: {
    name: "Custom STM32 Board",
    vendor: "Generic",
    mcu: {
      vendor: "ST",
      part: "STM32F407VGT6",
      package: "LQFP100",
      clock: { hse_hz: 8000000 },
      debug: { swd: true, uart: "UART1" },
    },
    sdk: "STM32Cube",
    language: "C",
  },
  netlist_extract: {
    interfaces: [
      {
        peripheral: "I2C1",
        signals: [
          { mcu_pin: "PB6", signal: "SCL", net: "I2C1_SCL" },
          { mcu_pin: "PB7", signal: "SDA", net: "I2C1_SDA" },
        ],
        devices: [
          { ref: "U3", type: "sensor", name: "MPU6050", address: "0x68" },
          { ref: "U4", type: "display", name: "SSD1306", address: "0x3C" },
        ],
      },
    ],
    gpio: [
      { net: "LED1", mcu_pin: "PC13", direction: "out", active_level: "low" },
      { net: "KEY1", mcu_pin: "PA0", direction: "in", pull: "up" },
    ],
    uart: [
      { peripheral: "USART1", tx: "PA9", rx: "PA10", baud: 115200, usage: "log" }
    ]
  },
  // User requirements will be built dynamically from the UI
};

// -----------------------------------------------------------------------------
// Example Data
// -----------------------------------------------------------------------------
const EXAMPLES = [
  {
    id: "stm32_sensor",
    title: "STM32 I2C Sensor Hub",
    description: "STM32F4 + MPU6050 + SSD1306 OLED using HAL.",
    config: DEFAULT_INPUT_JSON,
    features: "Initialize I2C1.\nRead MPU6050 Accel/Gyro data every 50ms.\nUpdate OLED with X/Y/Z values.\nBlink status LED on data ready."
  },
  {
    id: "esp32_iot",
    title: "ESP32 IoT Data Logger",
    description: "ESP32-WROOM with WiFi and Deep Sleep.",
    config: {
      board: {
        name: "ESP32 DevKit",
        vendor: "Espressif",
        mcu: { vendor: "Espressif", part: "ESP32-WROOM-32", clock: { cpu_hz: 240000000 }, debug: { uart: "UART0" } },
        sdk: "ESP-IDF",
        language: "C"
      },
      netlist_extract: {
        interfaces: [
          { peripheral: "SPI2", signals: [{ mcu_pin: "IO23", signal: "MOSI" }, { mcu_pin: "IO19", signal: "MISO" }, { mcu_pin: "IO18", signal: "CLK" }, { mcu_pin: "IO5", signal: "CS" }], devices: [{ ref: "U2", type: "storage", name: "SD_Card" }] }
        ],
        gpio: [{ net: "WIFI_LED", mcu_pin: "IO2", direction: "out" }]
      }
    },
    features: "Connect to WiFi (SSID/PASS via menuconfig).\nSync SNTP time.\nLog temperature (simulated) to SD Card every 1min.\nEnter Light Sleep between logs."
  },
  {
    id: "arduino_robot",
    title: "Arduino Robot Controller",
    description: "Arduino Uno with Servo and Motor Driver.",
    config: {
      board: {
        name: "Arduino Uno",
        vendor: "Arduino",
        mcu: { vendor: "Microchip", part: "ATmega328P" },
        sdk: "Arduino",
        language: "C++"
      },
      netlist_extract: {
        pwm: [{ timer: "T1", channel: "A", mcu_pin: "D9", net: "SERVO_ARM" }],
        gpio: [{ net: "BTN_START", mcu_pin: "D2", direction: "in", pull: "up" }]
      }
    },
    features: "Servo sweep on button press.\nSerial debug output.\nDebounce button input."
  }
];

// -----------------------------------------------------------------------------
// Style Constants
// -----------------------------------------------------------------------------
const THEME = {
  bg: "#ffffff",
  fg: "#1b4332", // Ink Green
  border: "#1b4332",
  accent: "#1b4332",
  codeBg: "#f5fdf9", // Very light mint
  hover: "#e8f5e9",
  textLight: "#407a52",
  bgSecondary: "#f8f9fa"
};

// -----------------------------------------------------------------------------
// Components
// -----------------------------------------------------------------------------

const Header = ({ onOpenDocs, onOpenExamples }: any) => (
  <header style={{
    height: "50px",
    backgroundColor: THEME.bg,
    borderBottom: `1px solid ${THEME.border}`,
    display: "flex",
    alignItems: "center",
    padding: "0 20px",
    color: THEME.fg,
    fontFamily: "'Segoe UI', sans-serif",
    zIndex: 10
  }}>
    <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
      <div style={{ 
        width: "24px", height: "24px", 
        backgroundColor: THEME.fg,
        borderRadius: "2px", // Sharper corners for wireframe look
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: "14px", fontWeight: "bold", color: "white"
      }}>
        ⚡
      </div>
      <span style={{ fontWeight: 700, letterSpacing: "0.5px", fontSize: "15px" }}>E-Code Generator</span>
      <span style={{ fontSize: "11px", border: `1px solid ${THEME.fg}`, padding: "1px 5px", borderRadius: "2px", color: THEME.fg }}>v1.0</span>
    </div>
    <div style={{ marginLeft: "auto", display: "flex", gap: "20px", fontSize: "13px", fontWeight: "600" }}>
      <span className="nav-link" onClick={onOpenDocs} style={{ cursor: "pointer", color: THEME.fg }}>Documentation</span>
      <span className="nav-link" onClick={onOpenExamples} style={{ cursor: "pointer", color: THEME.fg }}>Examples</span>
      <style>{`
        .nav-link:hover { text-decoration: underline; opacity: 0.8; }
      `}</style>
    </div>
  </header>
);

const SectionTitle = ({ children, icon }: any) => (
  <div style={{ 
    display: "flex", alignItems: "center", gap: "8px", 
    fontSize: "12px", fontWeight: "800", color: THEME.fg, 
    textTransform: "uppercase", letterSpacing: "0.5px",
    marginBottom: "12px", marginTop: "16px",
    borderBottom: `1px dashed ${THEME.border}`,
    paddingBottom: "4px"
  }}>
    <span style={{ color: THEME.fg }}>{icon}</span>
    {children}
  </div>
);

const Label = ({ children }: any) => (
  <label style={{ 
    display: "block", fontSize: "11px", color: THEME.fg, 
    marginBottom: "4px", fontWeight: "600", opacity: 0.9 
  }}>
    {children}
  </label>
);

const Select = ({ label, value, options, onChange }: any) => (
  <div style={{ marginBottom: "12px" }}>
    <Label>{label}</Label>
    <div style={{ position: "relative" }}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: "100%",
          padding: "8px 10px",
          backgroundColor: "#ffffff",
          color: THEME.fg,
          border: `1px solid ${THEME.border}`,
          borderRadius: "2px",
          fontSize: "13px",
          outline: "none",
          cursor: "pointer",
          appearance: "none",
          fontFamily: "inherit",
          fontWeight: "500"
        }}
      >
        {options.map((opt: string) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
      <div style={{ 
        position: "absolute", right: "10px", top: "50%", transform: "translateY(-50%)", 
        pointerEvents: "none", fontSize: "10px", color: THEME.fg 
      }}>▼</div>
    </div>
  </div>
);

const TextInput = ({ label, value, onChange, placeholder }: any) => (
  <div style={{ marginBottom: "12px" }}>
    <Label>{label}</Label>
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        width: "100%",
        padding: "8px 10px",
        backgroundColor: "#ffffff",
        color: THEME.fg,
        border: `1px solid ${THEME.border}`,
        borderRadius: "2px",
        fontSize: "13px",
        outline: "none",
        boxSizing: "border-box",
        fontFamily: "inherit",
        fontWeight: "500"
      }}
    />
  </div>
);

// -----------------------------------------------------------------------------
// Markdown & Table Renderer
// -----------------------------------------------------------------------------
const renderInlineMarkdown = (text: string) => {
  return text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code style="background: #e8f5e9; border: 1px solid #c3e6cb; padding: 2px 5px; border-radius: 3px; font-family: monospace; font-size: 0.9em; color: #1b4332;">$1</code>');
};

const TableRenderer = ({ content }: { content: string }) => {
  const lines = content.trim().split('\n');
  if (lines.length < 2) return null;
  const headerLine = lines[0];
  const headers = headerLine.replace(/^\||\|$/g, '').split('|').map(h => h.trim());
  const dataRows = lines.slice(2).map(line => line.replace(/^\||\|$/g, '').split('|').map(c => c.trim()));

  return (
    <div style={{ overflowX: "auto", marginBottom: "20px", border: `1px solid ${THEME.border}`, borderRadius: "2px" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px", fontFamily: "'Segoe UI', sans-serif" }}>
        <thead style={{ backgroundColor: THEME.hover, color: THEME.fg }}>
          <tr>{headers.map((h, i) => <th key={i} style={{ padding: "10px 12px", borderBottom: `2px solid ${THEME.border}`, textAlign: "left", fontWeight: "700", whiteSpace: "nowrap" }}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {dataRows.map((row, r) => (
            <tr key={r} style={{ backgroundColor: r % 2 === 0 ? "#ffffff" : "#fcfcfc" }}>
              {row.map((c, i) => (
                <td key={i} style={{ padding: "8px 12px", borderBottom: r === dataRows.length - 1 ? "none" : "1px solid #eee", borderRight: i === row.length - 1 ? "none" : "1px solid #eee", color: "#333" }} dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(c) }} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const MarkdownViewer = ({ text }: { text: string }) => {
  const parts = text.split(/(```[\s\S]*?```)/g);
  const processProse = (block: string) => {
     return block
        .replace(/^# (.*$)/gm, '<h1 style="font-size: 22px; border-bottom: 2px solid #1b4332; padding-bottom: 8px; margin-top: 32px; margin-bottom: 16px; font-weight: 700; color: #1b4332;">$1</h1>')
        .replace(/^## (.*$)/gm, '<h2 style="font-size: 18px; border-bottom: 1px dashed #1b4332; padding-bottom: 6px; margin-top: 28px; margin-bottom: 14px; font-weight: 700; color: #1b4332;">$1</h2>')
        .replace(/^### (.*$)/gm, '<h3 style="font-size: 16px; font-weight: 700; margin-top: 24px; margin-bottom: 10px; color: #2d6a4f;">$1</h3>')
        .replace(/^\s*[-*]\s+(.*$)/gm, '<div style="margin-left: 20px; padding-left: 8px; text-indent: -18px; margin-bottom: 6px;"><span style="color: #1b4332; font-weight: bold; margin-right: 8px;">•</span>$1</div>')
        .replace(/^\s*(\d+)\.\s+(.*$)/gm, '<div style="margin-left: 20px; padding-left: 8px; text-indent: -24px; margin-bottom: 6px;"><span style="font-weight: 600; margin-right: 4px; color: #2d6a4f;">$1.</span>$2</div>')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/`(.*?)`/g, '<code style="background: #e8f5e9; border: 1px solid #c3e6cb; padding: 2px 5px; border-radius: 3px; font-family: monospace; font-size: 0.9em; color: #1b4332;">$1</code>')
        .replace(/\n(?![^<]*>)/g, '<br/>');
  };

  return (
    <div style={{ fontFamily: "'Segoe UI', Roboto, Helvetica, Arial, sans-serif", fontSize: "14px", lineHeight: "1.6", color: THEME.fg, paddingBottom: "50px" }}>
      {parts.map((part, index) => {
        if (part.startsWith("```")) {
          const match = part.match(/```(\w+)?\n([\s\S]*?)```/);
          const lang = match ? match[1] : "";
          const code = match ? match[2] : part.slice(3, -3);
          return (
            <div key={index} style={{ background: THEME.codeBg, border: `1px solid ${THEME.border}`, borderRadius: "4px", margin: "20px 0", overflow: "hidden", fontFamily: "'JetBrains Mono', 'Fira Code', monospace" }}>
              <div style={{ padding: "6px 12px", background: "#ffffff", borderBottom: `1px solid ${THEME.border}`, fontSize: "11px", fontWeight: "bold", color: THEME.textLight, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ textTransform: "uppercase" }}>{lang || "CODE"}</span>
                <span style={{ cursor: "pointer", opacity: 0.8, fontSize: "12px" }} onClick={() => navigator.clipboard.writeText(code)}>📋 COPY</span>
              </div>
              <pre style={{ margin: 0, padding: "16px", overflowX: "auto", fontSize: "13px", lineHeight: "1.5", color: "#24292e" }}>{code}</pre>
            </div>
          );
        } else {
          const blocks = part.split(/\n\n+/);
          return <React.Fragment key={index}>{blocks.map((block, i) => {
            const trimmed = block.trim();
            if (!trimmed) return null;
            const lines = trimmed.split('\n');
            if (lines.length >= 2 && lines[0].trim().startsWith('|') && lines[1].trim().includes('---')) {
              return <TableRenderer key={i} content={trimmed} />;
            }
            return <div key={i} style={{ marginBottom: "12px" }} dangerouslySetInnerHTML={{ __html: processProse(trimmed) }} />;
          })}</React.Fragment>;
        }
      })}
    </div>
  );
};

// -----------------------------------------------------------------------------
// Project Structure View
// -----------------------------------------------------------------------------
const ProjectStructureView = ({ output, sdk }: { output: string | null, sdk: string }) => {
  // Simple parser to extract file structure if present in markdown
  const structure = useMemo(() => {
    if (!output) return null;
    // Try to find a code block that looks like a tree or specific file listing
    // Often contained in "III. Project Skeleton"
    const lines = output.split('\n');
    const treeLines: string[] = [];
    let inTree = false;

    // Heuristic: finding a block of lines with / or |- symbols after a header indicating structure
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.match(/目录结构|Project Structure|File Tree/i)) {
        inTree = true;
        continue;
      }
      if (inTree) {
        if (line.startsWith('#') || (treeLines.length > 0 && line === '')) {
          inTree = false; // End of section
        } else if (line.match(/^[|\-+\\]/) || line.includes('/')) {
          treeLines.push(lines[i]); // Keep original indentation
        }
      }
    }
    return treeLines.length > 0 ? treeLines.join('\n') : null;
  }, [output]);

  const defaultStructure = useMemo(() => {
    if (sdk.includes("STM32")) return `
Project_Root/
├── Core/
│   ├── Inc/
│   │   ├── main.h
│   │   └── stm32f4xx_hal_conf.h
│   └── Src/
│       ├── main.c
│       ├── stm32f4xx_hal_msp.c
│       └── stm32f4xx_it.c
├── Drivers/
│   └── STM32F4xx_HAL_Driver/
├── App/
│   └── [Generated Files...]
└── MDK-ARM/
    └── Project.uvprojx`;
    
    if (sdk.includes("ESP-IDF")) return `
Project_Root/
├── main/
│   ├── CMakeLists.txt
│   └── app_main.c
├── components/
│   └── [Generated Drivers]/
├── CMakeLists.txt
└── sdkconfig`;

    return `
Project_Root/
├── src/
│   └── main.c
├── include/
└── README.md`;
  }, [sdk]);

  const content = structure || defaultStructure;

  return (
    <div style={{ padding: "20px" }}>
      <div style={{ 
        backgroundColor: "#2d2d2d", 
        color: "#f8f8f2", 
        padding: "20px", 
        borderRadius: "4px", 
        fontFamily: "'JetBrains Mono', monospace", 
        fontSize: "13px",
        whiteSpace: "pre",
        overflowX: "auto",
        boxShadow: "0 4px 6px rgba(0,0,0,0.1)"
      }}>
        {content.trim()}
      </div>
      {!structure && output && (
        <div style={{ marginTop: "12px", fontSize: "12px", color: "#666", fontStyle: "italic" }}>
          * Structure inferred from SDK defaults (exact tree not found in output).
        </div>
      )}
      {!output && (
        <div style={{ marginTop: "12px", fontSize: "12px", color: "#666" }}>
          Generate code to view the specific project structure.
        </div>
      )}
    </div>
  );
};

// -----------------------------------------------------------------------------
// Modal Component
// -----------------------------------------------------------------------------
const Modal = ({ title, onClose, children }: any) => (
  <div style={{
    position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: "rgba(255, 255, 255, 0.9)",
    zIndex: 100, display: "flex", justifyContent: "center", alignItems: "center"
  }}>
    <div style={{
      width: "600px", maxHeight: "80vh", backgroundColor: "#fff",
      border: `2px solid ${THEME.border}`, borderRadius: "4px",
      display: "flex", flexDirection: "column", boxShadow: "0 10px 25px rgba(0,0,0,0.1)"
    }}>
      <div style={{ 
        padding: "16px 20px", borderBottom: `1px solid ${THEME.border}`, 
        display: "flex", justifyContent: "space-between", alignItems: "center",
        backgroundColor: THEME.bgSecondary
      }}>
        <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: THEME.fg }}>{title}</h3>
        <button onClick={onClose} style={{ 
          background: "none", border: "none", fontSize: "20px", cursor: "pointer", color: THEME.fg 
        }}>×</button>
      </div>
      <div style={{ padding: "20px", overflowY: "auto", flex: 1 }}>
        {children}
      </div>
    </div>
  </div>
);

// -----------------------------------------------------------------------------
// Hardware Drop Zone Component
// -----------------------------------------------------------------------------
const HardwareDropZone = ({ onFileLoaded, isAnalyzing }: { onFileLoaded: (name: string) => void, isAnalyzing: boolean }) => {
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") setDragActive(true);
    else if (e.type === "dragleave") setDragActive(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) onFileLoaded(e.dataTransfer.files[0].name);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.preventDefault();
    if (e.target.files && e.target.files[0]) onFileLoaded(e.target.files[0].name);
  };

  return (
    <div
      onDragEnter={handleDrag} onDragLeave={handleDrag} onDragOver={handleDrag} onDrop={handleDrop}
      style={{
        border: `2px dashed ${dragActive ? THEME.textLight : "#cccccc"}`, borderRadius: "4px",
        backgroundColor: dragActive ? THEME.codeBg : "#fafafa", padding: "20px", textAlign: "center",
        cursor: isAnalyzing ? "wait" : "pointer", transition: "all 0.2s", marginBottom: "16px", position: "relative"
      }}
      onClick={!isAnalyzing ? () => inputRef.current?.click() : undefined}
    >
      <input ref={inputRef} type="file" onChange={handleChange} accept=".kicad_sch,.zip,.html,.csv,.xml,.json" style={{ display: "none" }} />
      {isAnalyzing ? (
        <div style={{ color: THEME.fg, fontSize: "12px", display: "flex", flexDirection: "column", alignItems: "center" }}>
          <div className="mini-spinner" style={{ width: "16px", height: "16px", border: `2px solid ${THEME.hover}`, borderTop: `2px solid ${THEME.fg}`, borderRadius: "50%", marginBottom: "8px", animation: "spin 1s linear infinite" }}></div>
          <span>Invoking KiCad Parser...</span>
        </div>
      ) : (
        <>
          <div style={{ fontSize: "24px", marginBottom: "8px", opacity: 0.5 }}>📂</div>
          <div style={{ fontSize: "12px", fontWeight: "bold", color: THEME.fg, marginBottom: "4px" }}>Upload Hardware Design</div>
          <div style={{ fontSize: "10px", color: "#666", lineHeight: "1.4" }}>Drag & Drop <strong>.kicad_sch</strong>, <strong>.zip</strong>, or <strong>iBOM.html</strong></div>
        </>
      )}
      <style>{`@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`}</style>
    </div>
  );
};

// -----------------------------------------------------------------------------
// Main App
// -----------------------------------------------------------------------------
type PeripheralItem = { id: string; name: string; type: string; selected: boolean; isCommon?: boolean; };

const App = () => {
  const [jsonInput, setJsonInput] = useState(JSON.stringify(DEFAULT_INPUT_JSON, null, 2));
  const [output, setOutput] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [analyzingHardware, setAnalyzingHardware] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [activeTab, setActiveTab] = useState<'console' | 'structure'>('console');
  const [modalType, setModalType] = useState<'docs' | 'examples' | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [featureDescription, setFeatureDescription] = useState("初始化所有选中的外设。\n传感器每100ms采样一次，数据通过串口打印。\n实现简单的CLI命令控制LED开关。");
  const [peripherals, setPeripherals] = useState<PeripheralItem[]>([]);

  // Derived state for peripherals from JSON
  useEffect(() => {
    try {
      const data = JSON.parse(jsonInput);
      const netlist = data.netlist_extract || {};
      const newItems: PeripheralItem[] = [];
      const seen = new Set<string>();
      const add = (name: string, type: string) => { if (name && !seen.has(name)) { seen.add(name); newItems.push({ id: name, name, type, selected: true }); } };

      if (Array.isArray(netlist.interfaces)) netlist.interfaces.forEach((iface: any) => iface.peripheral && add(iface.peripheral, "BUS"));
      ["uart", "adc", "pwm"].forEach((key) => Array.isArray(netlist[key]) && netlist[key].forEach((item: any) => add(item.peripheral || item.timer || item.channel || "Unknown", key.toUpperCase())));
      if (Array.isArray(netlist.gpio)) netlist.gpio.forEach((pin: any) => pin.net && add(pin.net, "GPIO"));

      setPeripherals(prev => {
        const commonItems = prev.filter(p => p.isCommon);
        const detected = newItems.filter(n => !commonItems.some(c => c.name === n.name));
        return [...detected, ...commonItems];
      });
    } catch (e) { /* ignore */ }
  }, [jsonInput]);

  const addCommonPeripheral = () => {
    const commons = [
      { name: "System Tick", type: "Sys" }, { name: "Watchdog", type: "Sys" },
      { name: "USB CDC", type: "Comm" }, { name: "RTC", type: "Time" }, { name: "DMA Controller", type: "Sys" }
    ];
    setPeripherals(prev => {
      const newOnes = commons.filter(c => !prev.some(p => p.name === c.name)).map(c => ({ id: c.name, name: c.name, type: c.type, selected: true, isCommon: true }));
      return [...prev, ...newOnes];
    });
  };

  const togglePeripheral = (id: string) => setPeripherals(prev => prev.map(p => p.id === id ? { ...p, selected: !p.selected } : p));

  const getJsonField = (path: string[]) => {
    try {
      let current: any = JSON.parse(jsonInput);
      for (const key of path) { if (current === undefined) return ""; current = current[key]; }
      return current || "";
    } catch { return ""; }
  };
  const updateJsonField = (path: string[], value: string) => {
    try {
      const obj = JSON.parse(jsonInput);
      let current = obj;
      for (let i = 0; i < path.length - 1; i++) { if (!current[path[i]]) current[path[i]] = {}; current = current[path[i]]; }
      current[path[path.length - 1]] = value;
      setJsonInput(JSON.stringify(obj, null, 2));
    } catch (e) { }
  };

  const simulateKiCadAnalysis = (filename: string) => {
    setAnalyzingHardware(true);
    setTimeout(() => {
      try {
        const parsedNetlist = {
          board: { name: filename.replace(/\.\w+$/, ""), vendor: "Custom PCB", mcu: { vendor: "ST", part: "STM32F407VGT6", package: "LQFP100", clock: { hse_hz: 25000000 }, debug: { swd: true, uart: "USART1" } }, sdk: "STM32Cube", language: "C" },
          netlist_extract: {
            interfaces: [
              { peripheral: "I2C1", signals: [{ mcu_pin: "PB8", signal: "SCL" }, { mcu_pin: "PB9", signal: "SDA" }], devices: [{ ref: "U101", type: "sensor", name: "BME280", address: "0x76" }] },
              { peripheral: "SPI1", signals: [{ mcu_pin: "PA5", signal: "SCK" }, { mcu_pin: "PA6", signal: "MISO" }, { mcu_pin: "PA7", signal: "MOSI" }, { mcu_pin: "PA4", signal: "CS" }], devices: [{ ref: "J1", type: "connector", name: "MicroSD_Slot" }] }
            ],
            gpio: [{ net: "USR_LED", mcu_pin: "PE2", direction: "out" }, { net: "USR_BTN", mcu_pin: "PC13", direction: "in", pull: "up" }],
            uart: [{ peripheral: "USART1", tx: "PA9", rx: "PA10", baud: 115200 }]
          }
        };
        setJsonInput(JSON.stringify(parsedNetlist, null, 2));
        setFeatureDescription("Initialize parsed peripherals. Log BME280 data to SD Card.");
      } catch (e) { console.error(e); } finally { setAnalyzingHardware(false); }
    }, 1500);
  };

  const handleGenerate = async () => {
    setLoading(true); setError(null); setOutput(null); setActiveTab('console');
    try {
      const baseJson = JSON.parse(jsonInput);
      const activePeripherals = peripherals.filter(p => p.selected).map(p => p.name);
      const finalPayload = { ...baseJson, user_requirements: { features: featureDescription.split('\n').filter(l => l.trim() !== ""), active_peripherals: activePeripherals } };
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [{ role: "user", parts: [{ text: "Input Data:" }, { text: JSON.stringify(finalPayload, null, 2) }] }],
        config: { systemInstruction: SYSTEM_INSTRUCTION, temperature: 0.2 }
      });
      response.text ? setOutput(response.text) : setError("No content generated.");
    } catch (e: any) { setError(e.message || "An unexpected error occurred."); } finally { setLoading(false); }
  };

  const loadExample = (ex: any) => {
    setJsonInput(JSON.stringify(ex.config, null, 2));
    setFeatureDescription(ex.features);
    setModalType(null);
  };

  const handleSearch = () => {
    if (!searchTerm || !textareaRef.current) return;
    const index = jsonInput.toLowerCase().indexOf(searchTerm.toLowerCase());
    if (index !== -1) {
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(index, index + searchTerm.length);
      const lines = jsonInput.substring(0, index).split('\n').length;
      textareaRef.current.scrollTop = (lines - 2) * 17;
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", backgroundColor: THEME.bg }}>
      <Header onOpenDocs={() => setModalType('docs')} onOpenExamples={() => setModalType('examples')} />
      
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Left Sidebar */}
        <div style={{ width: "400px", backgroundColor: "#ffffff", borderRight: `1px solid ${THEME.border}`, display: "flex", flexDirection: "column", boxSizing: "border-box" }}>
          <div style={{ flex: 1, overflowY: "auto", padding: "20px" }}>
            <div style={{ marginBottom: "16px" }}>
              <SectionTitle icon="⚡">1. Hardware & Platform</SectionTitle>
              <div style={{ backgroundColor: "#ffffff", padding: "12px", borderRadius: "2px", border: `1px solid ${THEME.border}` }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                  <Select label="Vendor" value={getJsonField(["board", "mcu", "vendor"])} options={["ST", "NXP", "Espressif", "TI", "Generic"]} onChange={(v: string) => updateJsonField(["board", "mcu", "vendor"], v)} />
                  <Select label="Language" value={getJsonField(["board", "language"])} options={["C", "C++", "Rust", "MicroPython", "Arduino"]} onChange={(v: string) => updateJsonField(["board", "language"], v)} />
                </div>
                <TextInput label="MCU Part Number" value={getJsonField(["board", "mcu", "part"])} placeholder="STM32F407..." onChange={(v: string) => updateJsonField(["board", "mcu", "part"], v)} />
                <Select label="SDK Framework" value={getJsonField(["board", "sdk"])} options={["STM32Cube", "ESP-IDF", "Zephyr", "Arduino", "MCUXpresso", "PlatformIO"]} onChange={(v: string) => updateJsonField(["board", "sdk"], v)} />
              </div>
            </div>
            <div style={{ marginBottom: "16px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <SectionTitle icon="📄">2. Netlist / Constraints</SectionTitle>
                <div onClick={() => fileInputRef.current?.click()} style={{ fontSize: "11px", color: THEME.fg, cursor: "pointer", textDecoration: "underline", fontWeight: "bold" }}>Import JSON</div>
                <input type="file" ref={fileInputRef} style={{ display: "none" }} accept=".json,.txt" onChange={(e) => { const f = e.target.files?.[0]; if(f) { const r = new FileReader(); r.onload = (ev) => setJsonInput(JSON.stringify(JSON.parse(ev.target?.result as string), null, 2)); r.readAsText(f); e.target.value = ""; } }} />
              </div>
              <HardwareDropZone onFileLoaded={simulateKiCadAnalysis} isAnalyzing={analyzingHardware} />
              <div style={{ position: "relative", marginBottom: "8px", marginTop: "8px" }}>
                <input type="text" placeholder="Find device or net..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleSearch()} style={{ width: "100%", padding: "6px 28px 6px 10px", backgroundColor: "#ffffff", border: `1px solid ${THEME.border}`, borderRadius: "2px", color: THEME.fg, fontSize: "12px", outline: "none" }} />
                <div onClick={handleSearch} style={{ position: "absolute", right: "8px", top: "50%", transform: "translateY(-50%)", cursor: "pointer", fontSize: "12px", color: THEME.fg }}>🔍</div>
              </div>
              <textarea ref={textareaRef} value={jsonInput} onChange={(e) => setJsonInput(e.target.value)} style={{ width: "100%", height: "180px", backgroundColor: "#ffffff", color: "#000000", border: `1px solid ${THEME.border}`, borderRadius: "2px", padding: "12px", fontFamily: "'JetBrains Mono', monospace", fontSize: "12px", resize: "vertical", outline: "none", lineHeight: "1.4" }} spellCheck={false} />
            </div>
            <div>
              <SectionTitle icon="🛠️">3. Features & Peripherals</SectionTitle>
              <div style={{ marginBottom: "12px" }}>
                <Label>Functional Description</Label>
                <textarea value={featureDescription} onChange={(e) => setFeatureDescription(e.target.value)} placeholder="Describe what the code should do..." style={{ width: "100%", height: "80px", backgroundColor: "#ffffff", color: THEME.fg, border: `1px solid ${THEME.border}`, borderRadius: "2px", padding: "8px", fontSize: "12px", resize: "vertical", outline: "none" }} />
              </div>
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                  <Label>Active Peripherals</Label>
                  <button onClick={addCommonPeripheral} style={{ background: "none", border: "none", color: THEME.fg, fontSize: "10px", textDecoration: "underline", cursor: "pointer", padding: 0 }}>+ Add Common</button>
                </div>
                <div style={{ border: `1px solid ${THEME.border}`, borderRadius: "2px", maxHeight: "150px", overflowY: "auto", backgroundColor: "#fff" }}>
                  {peripherals.length === 0 && <div style={{ padding: "10px", fontSize: "11px", color: "#888", fontStyle: "italic" }}>No peripherals detected.</div>}
                  {peripherals.map((p) => (
                    <div key={p.id} style={{ display: "flex", alignItems: "center", padding: "6px 8px", borderBottom: "1px solid #eee" }}>
                      <input type="checkbox" checked={p.selected} onChange={() => togglePeripheral(p.id)} style={{ marginRight: "8px", accentColor: THEME.fg, cursor: "pointer" }} />
                      <div style={{ flex: 1, fontSize: "12px", fontWeight: "500" }}>{p.name}</div>
                      <div style={{ fontSize: "10px", padding: "1px 4px", borderRadius: "2px", backgroundColor: THEME.hover, color: THEME.fg }}>{p.type}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
          <div style={{ padding: "20px", borderTop: `1px solid ${THEME.border}`, backgroundColor: "#ffffff" }}>
            <button onClick={handleGenerate} disabled={loading || analyzingHardware} style={{ width: "100%", backgroundColor: (loading || analyzingHardware) ? "#ffffff" : THEME.fg, color: (loading || analyzingHardware) ? THEME.fg : "#ffffff", border: `1px solid ${THEME.fg}`, borderRadius: "2px", padding: "12px", fontSize: "13px", fontWeight: "600", cursor: (loading || analyzingHardware) ? "not-allowed" : "pointer", transition: "all 0.2s", boxShadow: (loading || analyzingHardware) ? "none" : "2px 2px 0px rgba(27, 67, 50, 0.2)" }}>
              {(loading || analyzingHardware) ? "PROCESSING..." : "GENERATE CODE"}
            </button>
          </div>
        </div>

        {/* Right Panel */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", backgroundColor: "#ffffff" }}>
          <div style={{ height: "40px", backgroundColor: "#ffffff", borderBottom: `1px solid ${THEME.border}`, display: "flex", alignItems: "center", paddingLeft: "16px" }}>
            <div onClick={() => setActiveTab('console')} style={{ fontSize: "12px", color: THEME.fg, fontWeight: "700", borderBottom: activeTab === 'console' ? `3px solid ${THEME.fg}` : "none", padding: "10px 4px", height: "100%", boxSizing: "border-box", cursor: "pointer", opacity: activeTab === 'console' ? 1 : 0.6, marginRight: "20px" }}>OUTPUT CONSOLE</div>
            <div onClick={() => setActiveTab('structure')} style={{ fontSize: "12px", color: THEME.fg, fontWeight: "700", borderBottom: activeTab === 'structure' ? `3px solid ${THEME.fg}` : "none", padding: "10px 4px", height: "100%", boxSizing: "border-box", cursor: "pointer", opacity: activeTab === 'structure' ? 1 : 0.6 }}>PROJECT STRUCTURE</div>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "30px", boxSizing: "border-box" }}>
            {loading && (
              <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: THEME.fg }}>
                <div className="spinner" style={{ width: "40px", height: "40px", border: `3px solid ${THEME.hover}`, borderTop: `3px solid ${THEME.fg}`, borderRadius: "50%", marginBottom: "20px", animation: "spin 1s linear infinite" }}></div>
                <p style={{ fontSize: "14px", fontWeight: "700" }}>Synthesizing Drivers & Logic...</p>
              </div>
            )}
            {!loading && !output && !error && (
               <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: THEME.fg, opacity: 0.8 }}>
                 <div style={{ fontSize: "48px", marginBottom: "16px" }}>💻</div>
                 <p style={{ fontSize: "14px", fontWeight: "bold" }}>Ready to generate code.</p>
               </div>
            )}
            {error && <div style={{ padding: "16px", backgroundColor: "#fff1f2", border: "1px solid #be123c", color: "#be123c", borderRadius: "2px", fontSize: "13px" }}><strong>Generation Failed:</strong> {error}</div>}
            
            {!loading && output && activeTab === 'console' && <MarkdownViewer text={output} />}
            {!loading && activeTab === 'structure' && <ProjectStructureView output={output} sdk={getJsonField(["board", "sdk"])} />}
          </div>
        </div>
      </div>
      
      {/* Modals */}
      {modalType === 'docs' && (
        <Modal title="Documentation" onClose={() => setModalType(null)}>
          <div style={{ fontSize: "14px", lineHeight: "1.6", color: "#333" }}>
            <p><strong>E-Code Generator</strong> is a specialized agent for embedded systems development.</p>
            <h4 style={{ color: THEME.fg, marginBottom: "8px" }}>How to use:</h4>
            <ol style={{ marginLeft: "20px" }}>
              <li><strong>Select Hardware:</strong> Choose your MCU vendor, part number, and preferred SDK.</li>
              <li><strong>Import Netlist:</strong> Upload a KiCad schematic file (`.kicad_sch`), Netlist, or manually edit the JSON definition to map your peripherals.</li>
              <li><strong>Define Features:</strong> Describe the functional requirements (e.g., "Read sensor every 1s").</li>
              <li><strong>Generate:</strong> The agent will produce initialization code, drivers, and a main application loop.</li>
            </ol>
            <h4 style={{ color: THEME.fg, marginBottom: "8px" }}>Supported Inputs:</h4>
            <ul style={{ marginLeft: "20px" }}>
              <li>KiCad Schematics (.kicad_sch) - <em>Simulated parsing</em></li>
              <li>Interactive HTML BOM (iBOM) - <em>Simulated parsing</em></li>
              <li>Custom JSON (see Examples)</li>
            </ul>
          </div>
        </Modal>
      )}

      {modalType === 'examples' && (
        <Modal title="Project Examples" onClose={() => setModalType(null)}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
            {EXAMPLES.map(ex => (
              <div key={ex.id} onClick={() => loadExample(ex)} style={{ 
                border: `1px solid ${THEME.border}`, borderRadius: "4px", padding: "16px", 
                cursor: "pointer", backgroundColor: "#fff", transition: "all 0.2s" 
              }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = THEME.hover}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "#fff"}
              >
                <div style={{ fontWeight: "bold", fontSize: "14px", marginBottom: "6px", color: THEME.fg }}>{ex.title}</div>
                <div style={{ fontSize: "12px", color: "#666", marginBottom: "8px" }}>{ex.description}</div>
                <div style={{ fontSize: "10px", color: THEME.textLight, fontStyle: "italic" }}>Click to load configuration</div>
              </div>
            ))}
          </div>
        </Modal>
      )}

      <style>{`@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`}</style>
    </div>
  );
};

const container = document.getElementById("root");
const root = createRoot(container!);
root.render(<App />);