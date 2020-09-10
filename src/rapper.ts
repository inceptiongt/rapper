import chalk from 'chalk';
import { format } from 'json-schema-to-typescript/dist/src/formatter';
import { DEFAULT_OPTIONS } from 'json-schema-to-typescript';
import {
  Intf,
  IUrlMapper,
  RAPPER_TYPE,
  TRAILING_COMMA,
  IGeneratedCode,
  ICreatorExtr,
} from './types';
import { createBaseRequestStr, createBaseIndexCode } from './core/base-creator';
import ReduxCreator from './redux';
import {
  writeFile,
  mixGeneratedCode,
  getMd5,
  getOldProjectId,
  templateFilesOverwriteConfirm,
  templateFilesRelyConfirm,
  latestVersion,
} from './utils';
import { getInterfaces, getTemplate, getIntfWithModelName, uniqueItfs, creatHeadHelpStr } from './core/tools';
import { findDeleteFiles, findChangeFiles, findRapperVersion } from './core/scanFile';
import url = require('url');
import * as semver from 'semver';
import * as ora from 'ora';
const packageJson = require('../package.json');

export interface IRapper {
  /** 必填，redux、normal 等 */
  type: RAPPER_TYPE;
  /** 必填，api仓库地址，从仓库的数据按钮可以获得 */
  apiUrl: string;
  /** 选填，rap平台前端地址，默认是 http://rap2.taobao.org */
  rapUrl?: string;
  /** 选填，生成出 rapper 的文件夹地址, 默认 ./src/rapper */
  rapperPath?: string;
  /** 选填，url映射，可用来将复杂的url映射为简单的url */
  urlMapper?: IUrlMapper;
  /** 选填，输出模板代码的格式 */
  codeStyle?: {};
  /** 选填，类型变换 type Selector<T> = T */
  resSelector?: string;
}
export default async function({
  type,
  rapUrl = 'http://rap2.taobao.org',
  apiUrl = 'http://rap2api.taobao.org',
  rapperPath = './src/rapper',
  urlMapper = t => t,
  codeStyle,
  resSelector = 'type ResSelector<T> = T',
}: IRapper) {
  const rapperVersion: string = packageJson.version;
  console.log(`当前rapper版本: ${chalk.grey(rapperVersion)}`);
  const spinner = ora(chalk.grey('rapper: 开始检查版本'));
  spinner.start();
  /** 检查版本，给出升级提示 */
  try {
    const newVersion = await latestVersion('rap', rapperVersion.indexOf('beta') > -1);
    if (semver.lt(rapperVersion, newVersion)) {
      spinner.warn(chalk.yellow('rapper 升级提示: '));
      console.log(`  当前版本: ${chalk.grey(rapperVersion)}`);
      console.log(`  最新版本: ${chalk.cyan(newVersion)}`);
      // console.log(
      //   `  运行 ${chalk.green(`npm i -D ${packageJson.name}@latest && npm run rapper`)} 即可升级`,
      // );
    }
  } catch (err) {
    spinner.warn(`rapper 版本检查失败，${err.message}`);
  }

  /** 参数校验 */
  spinner.start(chalk.grey('rapper: 开始校验参数'));
  if (!type) {
    return new Promise(() => spinner.fail(chalk.red('rapper: 请配置 type 参数')));
  } else if (!['normal', 'redux'].includes(type)) {
    return new Promise(() => spinner.fail(chalk.red('rapper: type 参数配置错误，请重新配置')));
  }
  spinner.succeed(chalk.grey('rapper: 参数校验成功'));

  const apiParams = url.parse(apiUrl, true).query;
  const projectId = parseInt(Array.isArray(apiParams.id) ? apiParams.id[0] : apiParams.id);
  DEFAULT_OPTIONS.style = {
    ...DEFAULT_OPTIONS.style,
    singleQuote: true,
    semi: false,
    trailingComma: TRAILING_COMMA.ES5,
  };
  if (codeStyle && typeof codeStyle === 'object') {
    DEFAULT_OPTIONS.style = { ...codeStyle };
  }
  rapperPath = rapperPath.replace(/\/$/, '');
  rapUrl = rapUrl.replace(/\/$/, '');
  apiUrl = apiUrl.replace(/\/$/, '');

  /** 校验当前 rapper 的版本是否比旧模板代码版本低，强制升级 */
  const oldFilesRapperVersion = findRapperVersion(rapperPath);
  if (oldFilesRapperVersion && semver.lt(rapperVersion, oldFilesRapperVersion)) {
    return new Promise(() => {
      spinner.fail(
        chalk.red(
          'rapper 执行失败: 当前环境 rapper 版本低于已经生成的模板文件版本，为避免低版本覆盖高版本，请您升级',
        ),
      );
      console.log(`  当前版本: ${chalk.grey(rapperVersion)}`);
      console.log(`  当前模板文件版本: ${chalk.cyan(oldFilesRapperVersion)}`);
    });
  }

  /** 扫描找出生成的模板文件是否被手动修改过 */
  spinner.start(chalk.grey('rapper: 检测模板代码是否被修改'));
  const changeFiles = findChangeFiles(rapperPath);
  if (changeFiles.length) {
    spinner.warn(chalk.yellow('rapper: 检测到如下模板代码被修改'));
    changeFiles.forEach(str => {
      console.log(chalk.yellow(`    ${str}`));
    });
    const { confirmed } = await templateFilesOverwriteConfirm();
    if (!confirmed) {
      console.log(chalk.red('更新操作已终止'));
      process.exit(0);
      return;
    }
  } else {
    spinner.succeed(chalk.grey('rapper: 模板代码未被修改'));
  }

  /** 输出文件集合 */
  let outputFiles = [];
  /** 所有接口集合 */
  let interfaces: Array<Intf> = [];
  spinner.start(chalk.grey('rapper: 正在从 Rap 平台获取接口信息...'));
  try {
    interfaces = await getInterfaces(apiUrl);
    spinner.succeed(chalk.grey('rapper: 获取接口信息成功'));
  } catch (e) {
    return new Promise(() => spinner.fail(chalk.red(`rapper: 获取接口信息失败，${e}`)));
  }
  interfaces = uniqueItfs(getIntfWithModelName(rapUrl, interfaces, urlMapper));

  /**
   * 获取所有接口template
   */
  let template = [];
  spinner.start(chalk.grey('rapper: 正在从 Rap 平台获取接口模板...'));
  try {
    const rst = interfaces.map(i => {
      const { url, method } = i;
      return getTemplate(apiUrl, i.id).then(d => ({ [`${method}${url}`]: d }));
    });
    template = await Promise.all(rst);
    spinner.succeed(chalk.grey('rapper: 获取接口模板成功'));
  } catch (e) {
    return new Promise(() => spinner.fail(chalk.red(`rapper: 获取接口模板失败，${e}`)));
  }
  /** Rap 接口引用扫描，如果 projectId 更改了就不再扫描，避免过多的报错信息展现在Terminal */
  spinner.start(chalk.grey('rapper: 正在扫描接口依赖'));
  if (getOldProjectId(rapperPath) === String(projectId)) {
    const scanResult = findDeleteFiles(interfaces, [rapperPath]);
    if (scanResult.length && scanResult.length < 5) {
      spinner.warn(chalk.yellow('rapper: 如下文件使用了已被 Rap 删除或修改的接口'));
      scanResult.forEach(({ key, filePath, start, line }) => {
        console.log(chalk.yellow(`    接口: ${key}, 所在文件: ${filePath}:${line}:${start}`));
      });
      const { confirmed } = await templateFilesRelyConfirm();
      if (!confirmed) {
        console.log(chalk.red('更新操作已终止'));
        process.exit(0);
        return;
      }
    } else {
      spinner.succeed(chalk.grey('rapper: 未发现不合法依赖'));
    }
  } else {
    spinner.succeed(chalk.grey('rapper: 未发现不合法依赖'));
  }

  spinner.start(chalk.grey('rapper: 正在生成模板代码...'));
  let Creator: {
    createIndexStr?: () => IGeneratedCode;
    createDynamicStr?: (interfaces: Array<Intf>, extr: ICreatorExtr) => string;
    createBaseRequestStr?: (interfaces: Array<Intf>, extr: ICreatorExtr) => Promise<string>;
  } = {};
  switch (type) {
    case 'redux':
      Creator = ReduxCreator;
      break;
    default:
      Creator = {};
  }

  try {
    /** 生成 index.ts */
    const indexCodeArr: Array<IGeneratedCode> = [createBaseIndexCode()];
    if (Creator.createIndexStr) {
      indexCodeArr.push(Creator.createIndexStr());
    }
    const indexStr = `
      ${creatHeadHelpStr(rapUrl, projectId, rapperVersion)}
      ${mixGeneratedCode(indexCodeArr)}
    `;
    outputFiles.push({
      path: `${rapperPath}/index.ts`,
      content: format(indexStr, DEFAULT_OPTIONS),
    });

    /** 生成基础的 request.ts 请求函数和类型声明 */
    let requestStr = '';
    if (Creator.createBaseRequestStr) {
      requestStr = await Creator.createBaseRequestStr(interfaces, {
        rapUrl,
        resSelector,
      });
    } else {
      requestStr = await createBaseRequestStr(interfaces, {
        rapUrl,
        resSelector,
      });
    }
    requestStr = `
      ${creatHeadHelpStr(rapUrl, projectId, rapperVersion)}
      ${requestStr}
    `;
    outputFiles.push({
      path: `${rapperPath}/request.ts`,
      content: format(requestStr, DEFAULT_OPTIONS),
    });

    /** 生成 template.ts */
    const templateStr = `
      ${creatHeadHelpStr(rapUrl, projectId, rapperVersion)}
      const rst = ${JSON.stringify(template)}
      export default rst
    `;
    outputFiles.push({
      path: `${rapperPath}/template.ts`,
      content: format(templateStr, DEFAULT_OPTIONS),
    });

    /** 生成 ${type}.ts 动态的 */
    Creator.createDynamicStr &&
      outputFiles.push({
        path: `${rapperPath}/${type}.ts`,
        content: format(
          `
            ${creatHeadHelpStr(rapUrl, projectId, rapperVersion)}
            ${Creator.createDynamicStr(interfaces, { rapUrl, resSelector })}
          `,
          DEFAULT_OPTIONS,
        ),
      });

    /** 生成的模板文件第一行增加MD5 */
    outputFiles = outputFiles.map(item => ({
      ...item,
      content: `/* md5: ${getMd5(item.content)} */\n${item.content}`,
    }));
  } catch (err) {
    spinner.fail(chalk.red(`rapper: 失败！${err.message}`));
    return;
  }

  return Promise.all(outputFiles.map(({ path, content }) => writeFile(path, content)))
    .then(() => {
      spinner.succeed(chalk.green(`rapper: 成功！共同步了 ${interfaces.length} 个接口`));
    })
    .catch(err => {
      spinner.fail(chalk.red(`rapper: 失败！${err.message}`));
    });
}
