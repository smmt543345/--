/**
 * 文本格式探测与 JSON 解析（05 §2.1，B4）：纯函数，不碰 IO、不碰数据库。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DETECT_LINES,
  IMPORT_FILE_ACCEPT,
  TEXT_DELIMITERS,
  detectDelimiter,
  formatOfFile,
  jsonMatrix,
  splitTextRow,
  textMatrix,
  type TextDelimiter,
} from './import-detect.ts';
import { matchHeaderCell } from './import-mapping.ts';

describe('分隔符自动探测（05 §2.1）', () => {
  it('逗号：每行都是「书名,作者」', () => {
    assert.equal(detectDelimiter('活着,余华\n三体,刘慈欣'), ',');
  });

  it('制表符：从 Excel / 网页复制出来的表', () => {
    assert.equal(detectDelimiter('书名\t作者\tISBN\n活着\t余华\t9787506365437'), '\t');
  });

  it('竖线：markdown 表格，两端的边框不算列', () => {
    const text = '| 书名 | 作者 |\n| --- | --- |\n| 活着 | 余华 |';
    assert.equal(detectDelimiter(text), '|');
    assert.deepEqual(splitTextRow('| 书名 | 作者 |', '|'), ['书名', '作者']);
  });

  it('连续空格：对齐排版的名单；单个空格不算分隔符', () => {
    assert.equal(detectDelimiter('活着    余华\n三体    刘慈欣'), ' ');
    assert.equal(detectDelimiter('活着 余华'), null);
  });

  it('探测不出返回 null（调用方按逗号口径处理）', () => {
    assert.equal(detectDelimiter('活着\n三体\n9787108061690'), null);
  });

  it('每行都得出现：只有一行带制表符就不算制表符分隔', () => {
    assert.equal(detectDelimiter('书名\t作者\n活着'), null);
  });

  it('空行不参与判定，也不会把候选否掉', () => {
    assert.equal(detectDelimiter('活着,余华\n\n   \n三体,刘慈欣'), ',');
  });

  it(`只看前 ${DETECT_LINES} 行：第 ${DETECT_LINES + 1} 行换了分隔符也不影响`, () => {
    const head = Array.from({ length: DETECT_LINES }, () => '书,作者');
    assert.equal(detectDelimiter([...head, '书；作者'].join('\n')), ',');
  });

  it('优先级：同时成立时制表符 > 竖线 > 逗号 > 连续空格', () => {
    assert.equal(detectDelimiter('活着,余华\t文学'), '\t');
    assert.equal(detectDelimiter('活着，余华  x'), ' ');
  });

  it('四个候选都能被探到（候选清单就是 05 §2.1 的那四个）', () => {
    const samples: Record<TextDelimiter, string> = {
      '\t': '书名\t作者',
      '|': '| 书名 | 作者 |',
      ',': '书名,作者',
      ' ': '书名    作者',
    };
    assert.deepEqual([...TEXT_DELIMITERS], ['\t', '|', ',', ' ']);
    for (const delimiter of TEXT_DELIMITERS) assert.equal(detectDelimiter(samples[delimiter]), delimiter);
  });
});

describe('文本行切分与矩阵（05 §2.1）', () => {
  it('连续的分隔符按一个算：a\\t\\tb 是两列', () => {
    assert.deepEqual(splitTextRow('a\t\tb', '\t'), ['a', 'b']);
    assert.deepEqual(splitTextRow('a||b', '|'), ['a', 'b']);
  });

  it('textMatrix 保留空行：行号要对齐原始行', () => {
    const matrix = textMatrix('a,b\n\nc,d', ',');
    assert.equal(matrix.length, 3);
    assert.deepEqual(matrix[1], ['']);
  });

  it('BOM 不算进第一个单元格', () => {
    assert.deepEqual(textMatrix('\uFEFF书名,作者', ',')[0], ['书名', '作者']);
  });
});

describe('按扩展名分派（05 §2.1）', () => {
  it('支持的格式各有解析分支', () => {
    assert.equal(formatOfFile('书单.csv'), 'csv');
    assert.equal(formatOfFile('书单.txt'), 'text');
    assert.equal(formatOfFile('书单.md'), 'text');
    assert.equal(formatOfFile('书单.tsv'), 'text');
    assert.equal(formatOfFile('书单.json'), 'json');
    assert.equal(formatOfFile('书单.xlsx'), 'xlsx');
    assert.equal(formatOfFile('书单.xls'), 'xlsx');
    assert.equal(formatOfFile('书单.docx'), 'docx');
  });

  it('扩展名大小写不敏感', () => {
    assert.equal(formatOfFile('书单.CSV'), 'csv');
    assert.equal(formatOfFile('书单.DocX'), 'docx');
  });

  it('.doc 提示另存为 .docx（05 §2.1）', () => {
    assert.throws(() => formatOfFile('旧书单.doc'), /docx/);
  });

  it('认不出的扩展名报人话错误', () => {
    assert.throws(() => formatOfFile('书单.pdf'), /认不出/);
  });

  it('选择器接受的每个扩展名都有解析分支（两个清单不许走散）', () => {
    const extensions = IMPORT_FILE_ACCEPT.split(',').filter((item) => item !== '');
    assert.equal(extensions.length, 8);
    for (const extension of extensions) assert.doesNotThrow(() => formatOfFile(`书单${extension}`));
  });
});

describe('JSON 书单（05 §2.1）', () => {
  it('数组 + 英文字段名：值落进对应列', () => {
    const { header, rows } = jsonMatrix(
      '[{"title":"活着","author":"余华","isbn":"9787506365437","publisher":"作家出版社","publishDate":"2012-08","location":"书房","copies":2}]',
    );
    assert.equal(header[0], '书名');
    assert.deepEqual(rows[0], ['活着', '余华', '9787506365437', '作家出版社', '2012-08', '', '书房', '2']);
  });

  it('{ books: [...] } 包装 + 中文字段名', () => {
    const { rows } = jsonMatrix('{"books":[{"书名":"三体","作者":"刘慈欣","副本数":"3"}]}');
    assert.equal(rows[0]?.[0], '三体');
    assert.equal(rows[0]?.[1], '刘慈欣');
    assert.equal(rows[0]?.[7], '3');
  });

  it('authors / tags 数组用顿号拼；ISBN 大小写变体也认', () => {
    const { rows } = jsonMatrix('[{"title":"三体","authors":["刘慈欣","张三"],"tags":["科幻","文学"],"ISBN":"9787536692930"}]');
    assert.equal(rows[0]?.[1], '刘慈欣、张三');
    assert.equal(rows[0]?.[2], '9787536692930');
    assert.equal(rows[0]?.[5], '科幻、文学');
  });

  it('不认识的字段忽略，缺的字段留空', () => {
    const { rows } = jsonMatrix('[{"title":"活着","备注":"随手记","rating":5}]');
    assert.deepEqual(rows[0]?.filter((cell) => cell !== ''), ['活着']);
  });

  it('表头列名都能被别名词典认回原字段（json 进列映射的前提）', () => {
    const { header } = jsonMatrix('[{"title":"三体"}]');
    assert.deepEqual(
      header.map((cell) => matchHeaderCell(cell)),
      ['title', 'author', 'isbn', 'publisher', 'publishDate', 'tags', 'location', 'copies'],
    );
  });

  it('元素是字符串时当书名（最简写法）', () => {
    assert.equal(jsonMatrix('["活着","三体"]').rows[1]?.[0], '三体');
  });

  it('最外层不是数组也不是 { books: [...] } → 报人话错误', () => {
    assert.throws(() => jsonMatrix('{"books":"活着"}'), /数组/);
    assert.throws(() => jsonMatrix('"活着"'), /数组/);
  });

  it('空数组 → 报人话错误（不写库）', () => {
    assert.throws(() => jsonMatrix('[]'), /一条书目都没有/);
    assert.throws(() => jsonMatrix('{"books":[]}'), /一条书目都没有/);
  });

  it('不是合法 JSON → 报人话错误', () => {
    assert.throws(() => jsonMatrix('{title: 活着}'), /不是合法的 JSON/);
  });

  it('带 BOM 的 JSON 也能读（记事本存出来的那种）', () => {
    assert.equal(jsonMatrix('\uFEFF[{"title":"活着"}]').rows[0]?.[0], '活着');
  });
});
