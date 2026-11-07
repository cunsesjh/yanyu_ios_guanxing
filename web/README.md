# 烟雨江湖工具（洗脉 + 盲晶）公网部署记录

> 本文档记录本工具在腾讯云 CloudBase 静态网站托管的部署信息，用于后续更新与维护。

## 部署概况

| 项目 | 值 |
|---|---|
| 部署平台 | 腾讯云 CloudBase 静态网站托管 |
| 环境 ID | `yanyu-utils-d5gbsti2m3c6c8344` |
| 环境名称 | yanyu-utils |
| 套餐 | 免费体验版（baas_trial，3000 资源点/月） |
| 地域 | ap-shanghai（上海） |
| 创建时间 | 2026-09-02 |

## 公网访问地址

- 首页：`https://yanyu-utils-d5gbsti2m3c6c8344-1322253382.tcloudbaseapp.com/`
- 静态托管控制台：登录腾讯云控制台 → 云开发 CloudBase → 选择环境 `yanyu-utils` → 静态网站托管

> 默认域名（`.tcloudbaseapp.com`）由腾讯云提供，免 ICP 备案；国内可直连访问。

## 站点结构

```
<静态托管根目录>
├── index.html          主页（存档导入入口）
├── home.js / home.css
├── txt-filter.html     文本过滤工具
├── auto/               自动洗脉/盲晶
├── wash/               洗脉模拟
├── equip/              装备洗练/优化
├── role/               角色相关
├── hengshan/           衡山相关
├── shared/             公共 JS/CSS/WASM
└── downloads/
    └── yanyu-save-exporter-v3.0.0.zip   导出工具下载
```

## 上传说明

- 上传时**排除**了 `serve.js`（仅本地开发服务器用）与 `downloads/` 下两个辅助脚本（`_list_zip.js`、`_list_zip.ps1`）。
- 其余文件原样整包上传，静态托管默认索引已配置为 `index.html`。

## 功能边界（重要）

- **存档导入只支持两种文件**：
  1. 本地导出的加密存档 `.yanyu`（magic `YANYUPL1`）：**本地解密，完全离线**；
     其中 v2 版本会绑定一张授权码（文件里只存 8 字节码指纹用于溯源，没有码解不开）。
  2. 明文 JSON（一键导出工具生成的 `.json`）。
- 旧的官方加密存档（v1.8 / v1.8.3 / v1.9 / v2.0 / v2.1 / v3.0 / v3.1）解析、以及配套的
  `./api/license` 授权代理（`serve.js` 里的三级回退）**已全部移除**。
- 存档存储：解密后的数据放在浏览器 `localStorage`（`yyjh_share_save_v1`），各页面共用。

## 部署与更新命令（备忘）

后续更新文件后，重新上传到静态托管根目录即可（文件同名覆盖）：

1. 登录腾讯云控制台 → 云开发 CloudBase → 环境 `yanyu-utils`
2. 静态网站托管 → 上传文件 → 选择本目录下需要更新的文件
3. 完成后带查询串访问（如 `?t=<时间戳>`）验证 CDN 缓存刷新

也可使用 CloudBase CLI：

```bash
# 登录（浏览器授权）
tcb login

# 部署整个目录到静态托管
tcb hosting deploy "yanyu-utils（最新兼容最新存档，洗脉+盲晶）" -e yanyu-utils-d5gbsti2m3c6c8344
```

## 费用说明

免费体验版提供 3000 资源点/月，静态托管流量由资源点抵扣。小范围使用（几十人）通常足够；若超量需在控制台按量付费或升级套餐，否则可能暂停服务。
