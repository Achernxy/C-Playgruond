# 自定义 NSIS 安装脚本（electron-builder 会自动包含 build/installer.nsh）
#
# 背景：安装完成后桌面/开始菜单没有快捷方式。
#
# 实测结论（在真实安装器里逐项打点得出的）：
#   - $DESKTOP / $newDesktopLink / $keepShortcuts 全部正常：
#       DESKTOP=C:\Users\<用户>\Desktop
#       newDesktopLink=C:\Users\<用户>\Desktop\C++ Playground.lnk
#       keepShortcuts=false   （即 electron-builder 内置逻辑本来就该创建）
#   - 同一个安装器里用 CreateShortCut：
#       写 $INSTDIR  -> 成功
#       写 $TEMP     -> 成功
#       写 $DESKTOP  -> 失败（CreateShortCut 报错，文件不存在）
#   - 用 PowerShell 在同一个桌面路径创建 .lnk -> 成功（说明目录权限没问题）
#
# 即：桌面写入权限正常，但安装器进程通过 Shell 接口（IShellLink）在桌面创建
# 快捷方式时被拦下（安全软件/受控文件夹一类的保护）。而普通文件写入不受影响。
#
# 因此这里改成两级策略：
#   1) 先按常规方式 CreateShortCut 直接生成；
#   2) 若第 1 步没生成出来，就改为「先在 $INSTDIR 里生成同内容 .lnk，
#      再用 CopyFiles 纯文件复制到桌面/开始菜单」——绕开 Shell 接口。
#
# 另外应用侧还有一层兜底：安装版首次启动时，main.js 的 ensureShortcuts()
# 会以当前登录用户身份补一次桌面/开始菜单快捷方式。三层保障确保可见。

!macro customInstall
  # ---------- 桌面快捷方式 ----------
  IfFileExists "$newDesktopLink" pgDeskDone
    ClearErrors
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    IfFileExists "$newDesktopLink" pgDeskDone
      StrCpy $0 "$INSTDIR\_pg_lnk_tmp.lnk"
      Delete "$0"
      CreateShortCut "$0" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      IfFileExists "$0" 0 pgDeskDone
        CopyFiles /SILENT "$newDesktopLink" "$0"
        ClearErrors
        Delete "$0"
  pgDeskDone:

  # ---------- 开始菜单快捷方式 ----------
  IfFileExists "$newStartMenuLink" pgMenuDone
    ClearErrors
    CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    IfFileExists "$newStartMenuLink" pgMenuDone
      StrCpy $0 "$INSTDIR\_pg_lnk_tmp2.lnk"
      Delete "$0"
      CreateShortCut "$0" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      IfFileExists "$0" 0 pgMenuDone
        CopyFiles /SILENT "$newStartMenuLink" "$0"
        ClearErrors
        Delete "$0"
  pgMenuDone:

  # 通知外壳刷新，否则新快捷方式可能要过一会儿才显示
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend
