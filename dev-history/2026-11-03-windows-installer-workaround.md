# Windows 安装器重复提示无法关闭：免安装分发

用户确认重启后0.1.6 NSIS仍提示CKD SOP Cloud cannot be closed。此前将其直接解释为旧程序残留并不充分。读取本机已安装的electron-builder 26.15.3 NSIS模板：FIND_PROCESS在PowerShell可用时遍历Get-CimInstance Win32_Process，按Path.StartsWith(INSTDIR)判断；普通关闭及强制关闭后仍匹配则显示此提示。实际Windows是否有占用、权限问题、安装目录范围或策略问题，当前没有现场证据，未认定具体根因。

没有修改进程关闭宏，没有跳过真正的文件锁保护，也没有修改后端。将已构建/静态校验的0.1.6 win-unpacked完整目录打成ZIP，提供绕过安装步骤的分发方式。用户须完整解压并保留所有文件，然后运行CKD SOP Cloud.exe。

验证：ZipFile.testzip全成员CRC校验、关键EXE/app.asar存在、无符号链接及.env/.data；沿用先前asar逐字节核验结果。Windows实机运行仍待用户验证，不能宣称安装器已修复。没有调用真实模型或改变VPS。
