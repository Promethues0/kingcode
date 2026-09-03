// 设备超级管理员扩展 —— 只在「MDM 模式」下编进包里（见 harmony/mdm.sh）。
//
// 它做的唯一一件事：把系统自带的「终端」（com.huawei.hmos.hishell）加进
// **开机自启**与**保活**白名单。做完之后，终端由系统托管——开机就在、后台不被回收、
// 也不用用户自己去开，KingCode 的引擎（跑在终端域里的 Node）因此常驻。
// 用户那一侧就真正只剩一个动作：点 KingCode 图标。
//
// 为什么非走 EDM 不可：引擎是 Node，HarmonyOS 上只有终端那个域能 exec；而终端会被
// 系统在后台回收、窗口关掉就死。让第三方应用直接拉起终端 / 让终端脱离沙箱都被系统拦死
// （五条死路见 pages/Index.ets 的注释）。企业设备管理（EDM）的白名单是唯一的正规出口。
//
// 代价：addAutoStartApps / addKeepAliveApps 要 super administrator 身份 +
// ohos.permission.ENTERPRISE_MANAGE_APPLICATION，后者只有 MDM 企业签名
//（provision 的 app-feature = hos_enterprise_mdm）的包能拿到。所以这套只对
// 有企业开发者账号的人可用（个人调试证书装不上，会报 9568289）。
//
// 激活（一次性，连着电脑，因为 /system/bin 对终端不可见）：
//   hdc shell edm enable-admin -n com.kingcode.client \
//       -a com.kingcode.client.EnterpriseAdminAbility -t super
// 撤销：hdc shell edm disable-admin -n com.kingcode.client
import { EnterpriseAdminExtensionAbility, applicationManager } from '@kit.MDMKit';
import { Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN = 0x0000;
const HISHELL = 'com.huawei.hmos.hishell';
const MAIN_ACCOUNT = 100;   // 鸿蒙 PC 主用户

function whitelistHiShell(): void {
  // admin 就是本扩展自己。addAutoStartApps 认 Want，addKeepAliveApps 认 bundleName。
  const self: Want = {
    bundleName: 'com.kingcode.client',
    abilityName: 'com.kingcode.client.EnterpriseAdminAbility',
  };
  const hishellAbility: Want = { bundleName: HISHELL, abilityName: 'EntryAbility' };

  try {
    applicationManager.addAutoStartApps(self, [hishellAbility]);
    hilog.info(DOMAIN, 'kingcode', 'EDM: HiShell 已加进开机自启白名单');
  } catch (e) {
    hilog.error(DOMAIN, 'kingcode', 'EDM addAutoStartApps 失败: %{public}s', JSON.stringify(e));
  }

  try {
    applicationManager.addKeepAliveApps(self, [HISHELL], MAIN_ACCOUNT);
    hilog.info(DOMAIN, 'kingcode', 'EDM: HiShell 已加进保活白名单');
  } catch (e) {
    hilog.error(DOMAIN, 'kingcode', 'EDM addKeepAliveApps 失败: %{public}s', JSON.stringify(e));
  }
}

export default class EnterpriseAdminAbility extends EnterpriseAdminExtensionAbility {
  // 被 `edm enable-admin -t super` 激活时触发：立刻把终端加进白名单。
  onAdminEnabled(): void {
    hilog.info(DOMAIN, 'kingcode', 'EDM: admin enabled');
    whitelistHiShell();
  }

  onAdminDisabled(): void {
    hilog.info(DOMAIN, 'kingcode', 'EDM: admin disabled');
  }
}
