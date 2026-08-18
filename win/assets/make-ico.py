#!/usr/bin/env python3
"""把一组 PNG 组装成多尺寸 .ico。

Windows Vista 起 ICO 支持直接内嵌完整 PNG 帧（不加 BITMAPINFOHEADER、
不用双倍高度、不用 AND 掩码），256×256 用 PNG 帧是官方推荐做法——否则
一张 256 的 BMP 帧就要 256KB。

刻意不依赖 Pillow/System.Drawing：ICO 容器就是两段定长结构 + 原样拼接的
PNG 字节，用 struct 写反而没有跨平台包袱（System.Drawing.Common 自 .NET 7
起在非 Windows 上直接抛 PlatformNotSupportedException，用不了）。

用法：make-ico.py <输出.ico> <png...>
"""
import struct
import sys
from pathlib import Path


def build(pngs):
    """按 ICONDIR + ICONDIRENTRY[] + 图像数据 的布局拼出 ICO 字节。"""
    entries, blobs = [], []
    # 数据区紧跟在目录之后
    offset = 6 + 16 * len(pngs)
    for path in pngs:
        data = Path(path).read_bytes()
        # PNG 的 IHDR 从第 16 字节起是宽高（各 4 字节大端）
        if data[:8] != b'\x89PNG\r\n\x1a\n':
            raise SystemExit(f'{path} 不是 PNG')
        width, height = struct.unpack('>II', data[16:24])
        if width > 256 or height > 256:
            raise SystemExit(f'{path} 尺寸 {width}x{height} 超出 ICO 上限 256')
        # 宽高字段为 0 表示 256
        entries.append(struct.pack('<BBBBHHII',
                                   width % 256, height % 256,
                                   0,      # bColorCount：真彩色写 0
                                   0,      # bReserved
                                   1,      # wPlanes
                                   32,     # wBitCount
                                   len(data), offset))
        blobs.append(data)
        offset += len(data)
    header = struct.pack('<HHH', 0, 1, len(pngs))   # idReserved / idType=1(ICO) / idCount
    return header + b''.join(entries) + b''.join(blobs)


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    out, pngs = sys.argv[1], sys.argv[2:]
    # 按尺寸升序，看图工具默认取第一条目时拿到的是小图
    pngs.sort(key=lambda p: struct.unpack('>I', Path(p).read_bytes()[16:20])[0])
    Path(out).write_bytes(build(pngs))
    print(f'已写出 {out}（{len(pngs)} 个尺寸，{Path(out).stat().st_size} 字节）')


if __name__ == '__main__':
    main()
