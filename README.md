# 账页核对

账页核对是一个面向采购跟单、采购助理和供应链运营人员的 Chrome / Edge 扩展。收到新版采购台账时，可以按订单号匹配两期记录，定位交期、数量和交付状态等字段的变化，并导出 Excel 差异清单供同事复核。

适用于两期采购台账可以从业务系统导出为 CSV，或在网页上显示为普通表格的场景。遇到插行、重排或一单多行时，可用稳定的单号和明细编号配对，空号和重号会单独列为待复核。当前版本 0.1.1 为免费试用版。

## 获取与安装

1. 打开 [GitHub 版本发布页](https://github.com/wwb45703-creator/zhangye/releases/tag/v0.1.1)，在 Assets 下载 [zhangye-0.1.1-trial.zip](https://github.com/wwb45703-creator/zhangye/releases/download/v0.1.1/zhangye-0.1.1-trial.zip)。试用包已构建，安装无需 Node.js。
2. 解压 ZIP。使用桌面版 Edge 时，在地址栏打开 `edge://extensions/`。使用桌面版 Chrome 时，打开 `chrome://extensions/`。
3. 启用「开发人员模式」，点击「加载解压缩的扩展」，选中解压后的 `extension` 文件夹。该文件夹里应直接看到 `manifest.json`。
4. 从浏览器工具栏的扩展菜单打开「账页核对」，选择「打开核对台」。企业设备若限制安装扩展，请通过单位的应用管理流程确认。

## 使用说明

### 先用示例试一次

在核对台点击「载入示例」。示例会显示字段变更 3 项、仅本期有 2 项、本期未见 1 项、待复核 2 项，另有 2 条无变化。点击任意差异行的「查看」看前后值，再点击「导出 Excel」生成 XLSX。可用 Microsoft Excel 或 WPS 表格打开。 [核对台截图](docs/deployment/screenshots/workbench.png)

### 核对自己的两期台账

1. **导入上期和本期。** 在核对台的两个期别卡片分别导入 CSV。也可以打开业务网页，点击扩展中的「读取当前页」，选中表格后存为对应期别。核对两期的筛选、分页及导出范围是否一致。
2. **设置配对方式。** 两期分别选择稳定的订单编号列。一单多行时，勾选「一单多行，加入明细编号」，再指定两期的明细编号列。保留编号前导零。
3. **选择字段。** 勾选交期、数量或状态等两期同名字段，点击「开始核对」。
4. **查看并导出。** 先检查空编号和重复编号，再查看前后值。「本期未见」表示本期输入里没有匹配行，是否取消需回到原系统确认。导出 XLSX 后可保存规则，下次复用。

CSV 使用逗号分隔，支持 UTF-8、GB18030，每期最多 5,000 行、2–48 列、1.5 MB，首行应为唯一表头。手头只有 XLSX 时，在 Excel 或 WPS 把要对比的工作表另存为 CSV。网页读取适用于当前主页面中已渲染的标准 HTML 表格。复杂网页列表可使用业务系统的 CSV 导出。

## 隐私与反馈

台账、规则和核对结果在浏览器本机处理。可从核对台的「数据管理」备份、恢复或清除台账。反馈时请使用合成或脱敏数据，说明浏览器、操作步骤和实际结果。 [隐私政策](docs/deployment/privacy-policy.md) · [提交问题](https://github.com/wwb45703-creator/zhangye/issues)

## 开发与复测

Node.js 22 及以上。Windows PowerShell 使用 `npm.cmd`。

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run build
npm.cmd run test:browser
npm.cmd run test:excel
```

源码 `extension/` 可直接加载。构建产物位于 `dist/`。浏览器测试从实际 ZIP 解包，在隔离配置中运行 Chrome 与 Edge，生成合成报表和截图。`test:excel` 使用 Windows 注册的表格程序，按实际安装路径报告 WPS 或 Microsoft Excel，并用实际导出 CSV 验证中文往返。单独测微软 Excel 可运行 `npm.cmd run test:excel -- -Engine Microsoft`。`ZHANGYE_CHROME`、`ZHANGYE_EDGE`、`ZHANGYE_EXCEL_EXE` 可指定非默认安装路径。测试前应关闭其他表格窗口。

`npm.cmd run test:public` 从官方公告读取两张实表并验证 XLSX。`npm.cmd run test:public -- --microsoft` 使用原生 Microsoft Excel 验证。[公开网页练习](docs/product-validation/public-procurement.md)
