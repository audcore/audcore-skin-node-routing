const labels = {
  "新建输入": ["Add input", "入力追加"],
  "新建输出": ["Add output", "出力追加"],
  "自动排布": ["Auto layout", "自動配置"],
  "画布菜单": ["Canvas menu", "画面操作"],
  "输出总线": ["Output bus", "出力バス"],
  "仅接收连线": ["Routed input", "経路入力"],
  "设备不可用": ["Unavailable", "使用不可"],
  "暂无已配置设备": ["No devices configured", "設定機器なし"],
  "发送设置": ["Send settings", "送信設定"],
  "取样位置": ["Tap point", "取出位置"],
  "发送增益 dB": ["Send gain dB", "送信 dB"],
  "推子前": ["Pre-fader", "前段"],
  "推子后": ["Post-fader", "後段"],
  "居中并恢复 100%": ["Center at 100%", "中央・等倍"],
  "选择设备": ["Select device", "機器選択"],
  "连线已删除": ["Send removed", "送信削除"],
  "发送设置已保存": ["Send settings saved", "送信保存"],
  "此发送目标暂不可用": ["Send target unavailable", "送信先なし"],
  "请更新声核以一次移除多条连线": ["Update Audcore to remove multiple sends", "一括削除には更新が必要"],
};

export function skinLabel(host, key) {
  const common = host?.i18n?.t(key) ?? key;
  if (common !== key) return common;
  const language = host?.i18n?.getLanguage()?.split("-")[0];
  return labels[key]?.[language === "en" ? 0 : language === "ja" ? 1 : -1] ?? key;
}

export function nodeTitle(node) {
  return node.hardwareOutput ? node.name.replace(/^playback\b/i, "BACK") : node.name;
}
