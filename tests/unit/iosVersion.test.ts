/**
 * iOS App 的版本号必须与服务器（package.json，也是网页设置页显示的版本）一致（2026-10-24）。
 * 原生客户端在 ios/main 长期维护、服务器在 main 发布：合并 main 时这条测试防止两边版本号各走各的。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');

describe('iOS 与服务器版本号', () => {
  it('Xcode 工程的 MARKETING_VERSION（Debug 与 Release）等于 package.json 的 version', () => {
    const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
    const project = fs.readFileSync(path.join(root, 'iOS/SuperErrorLog.xcodeproj/project.pbxproj'), 'utf8');
    const found = [...project.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map(match => match[1]!.trim());
    expect(found).toHaveLength(2);
    for (const value of found) expect(value).toBe(version);
  });
});
