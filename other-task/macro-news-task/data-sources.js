/**
 * 宏观经济与行业数据源配置
 *
 * 每个数据源包含:
 *   - name:        数据源名称
 *   - category:    分类 (macro / industry)
 *   - description: 要获取的具体数据说明
 *   - urls:        需要爬取的 URL 列表
 *   - prompt:      给 LLM 的解读指令
 */

const MACRO_SOURCES = [
  {
    name: 'M2_M1_M0',
    category: 'macro',
    description: 'M2、M1、M0 货币供应量',
    urls: [
      'http://www.pbc.gov.cn/diaochatongjisi/116219/116225/index.html',
    ],
    prompt: '请解读最新的 M2、M1、M0 货币供应量数据，分析货币政策松紧趋势，以及对经济和市场的潜在影响。',
  },
  {
    name: '利率_LPR',
    category: 'macro',
    description: '贷款市场报价利率 (LPR)',
    urls: [
      'http://www.pbc.gov.cn/zhengcehuobisi/125207/125213/125440/125838/125888/index.html',
    ],
    prompt: '请解读最新的 LPR 利率数据，分析利率变动趋势及其对房地产、企业融资成本的影响。',
  },
  {
    name: '进出口_外汇储备',
    category: 'macro',
    description: '进出口数据、FDI净值与顺差、外汇储备',
    urls: [
      'http://www.customs.gov.cn/customs/302249/zfxxgk/2799825/302274/index.html',
      'http://www.safe.gov.cn/safe/tjsj/index.html',
    ],
    prompt: '请综合解读最新的进出口贸易数据、FDI净值与贸易顺差、外汇储备数据，分析中国对外贸易格局变化和资本流动趋势。',
  },
  {
    name: '债务',
    category: 'macro',
    description: '中央财政债务余额',
    urls: [
      'http://gks.mof.gov.cn/tongjishuju/',
    ],
    prompt: '请解读最新的中央财政债务数据，分析政府债务水平及财政可持续性。',
  },
  {
    name: '人口结构',
    category: 'macro',
    description: '人口结构、死亡率、出生率',
    urls: [
      'https://data.stats.gov.cn/easyquery.htm?cn=C01',
    ],
    prompt: '请解读最新的人口结构数据（包括出生率、死亡率、年龄结构等），分析人口趋势对经济和社会的长期影响。',
  },
  {
    name: '失业金发放',
    category: 'macro',
    description: '社会保险事业发展统计',
    urls: [
      'http://www.mohrss.gov.cn/SYrlzyhshbzb/zwgk/szrs/tjgb/',
    ],
    prompt: '请解读最新的失业保险金发放数据和社会保险统计，分析就业市场状况和社会保障覆盖情况。',
  },
  {
    name: '可支配收入',
    category: 'macro',
    description: '居民人均可支配收入',
    urls: [
      'https://data.stats.gov.cn/easyquery.htm?cn=B01',
    ],
    prompt: '请解读最新的居民人均可支配收入数据，分析城乡收入差距和消费能力变化趋势。',
  },
  {
    name: 'CPI_PPI_PMI',
    category: 'macro',
    description: 'CPI、PPI、PMI 经济指标',
    urls: [
      'http://www.stats.gov.cn/sj/zxfb/',
    ],
    prompt: '请解读最新的 CPI、PPI 和 PMI 数据，分析通胀/通缩压力和制造业景气度，判断经济周期位置。',
  },
  {
    name: '税收_财政收支',
    category: 'macro',
    description: '税收和财政收支情况',
    urls: [
      'http://gks.mof.gov.cn/tongjishuju/',
    ],
    prompt: '请解读最新的财政收支数据，分析税收收入变化趋势和财政支出结构调整方向。',
  },
];

const INDUSTRY_SOURCES = [
  {
    name: '发电量_用电量',
    category: 'industry',
    description: '发电量和用电量数据',
    urls: [
      'http://www.nea.gov.cn/sj/index.htm',
    ],
    prompt: '请解读最新的发电量和用电量数据，分析电力供需形势和经济活跃度。',
  },
  {
    name: '煤炭_原油_天然气',
    category: 'industry',
    description: '煤炭、原油、天然气的供需数据',
    urls: [
      'https://data.stats.gov.cn/easyquery.htm?cn=A01',
      'http://www.customs.gov.cn/customs/302249/zfxxgk/2799825/302274/index.html',
    ],
    prompt: '请解读最新的煤炭、原油、天然气产量和进口量数据，分析能源供需格局和价格走势。',
  },
  {
    name: '有色金属_黑色金属',
    category: 'industry',
    description: '有色金属和黑色金属的供需数据（交易所库存）',
    urls: [
      'https://www.shfe.com.cn/statements/dataview.html?paramid=kx',
    ],
    prompt: '请解读上期所最新的金属库存数据，分析有色和黑色金属的供需变化和价格影响。',
  },
  {
    name: '橡胶_轮胎_汽车',
    category: 'industry',
    description: '天然橡胶、BR、轮胎、乘用车与重卡的行业数据',
    urls: [
      'http://www.caam.org.cn/chn/4/cate_39/',
      'https://www.shfe.com.cn/statements/dataview.html?paramid=kx',
    ],
    prompt: '请解读最新的汽车产销数据（乘用车和重卡）以及橡胶库存数据，分析汽车产业链和橡胶需求前景。',
  },
  {
    name: '公路物流指数',
    category: 'industry',
    description: '公路物流运价指数',
    urls: [
      'http://www.chinawuliu.com.cn/lwsj/',
    ],
    prompt: '请解读最新的公路物流运价指数，分析物流行业景气度和内需运输情况。',
  },
  {
    name: '芯片进出口',
    category: 'industry',
    description: '集成电路进出口量值',
    urls: [
      'http://www.customs.gov.cn/customs/302249/zfxxgk/2799825/302274/index.html',
    ],
    prompt: '请解读最新的集成电路（芯片）进出口数据，分析中国半导体产业的自主化进程和国际贸易格局。',
  },
  {
    name: '互联网巨头财报',
    category: 'industry',
    description: '腾讯、阿里、拼多多等财务报表',
    urls: [
      'https://www.hkexnews.hk/index_c.htm',
      'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=pinduoduo&CIK=&type=10-K&dateb=&owner=include&count=10&search_text=&action=getcompany',
    ],
    prompt: '请解读腾讯、阿里、拼多多等互联网巨头最新的财务报表摘要，分析营收增长、利润率变化和业务战略转型方向。',
  },
  {
    name: '银行财报',
    category: 'industry',
    description: '各主要银行财报（工商银行等）',
    urls: [
      'http://www.cninfo.com.cn/new/index',
    ],
    searchKeywords: ['601398', '601939', '601988', '601288'],
    prompt: '请解读主要银行最新财报数据，分析净息差变化、不良贷款率趋势和银行业整体经营状况。',
  },
  {
    name: '消费品公司财报',
    category: 'industry',
    description: '海天味业等消费品公司财报',
    urls: [
      'http://www.cninfo.com.cn/new/index',
    ],
    searchKeywords: ['603288'],
    prompt: '请解读主要消费品公司最新财报，分析消费复苏趋势和居民消费结构变化。',
  },
  {
    name: '茅台财报',
    category: 'industry',
    description: '贵州茅台(600519)财报',
    urls: [
      'http://www.cninfo.com.cn/new/disclosure/stock?stockCode=600519&orgId=gssh0600519',
    ],
    prompt: '请解读贵州茅台最新财报，分析高端白酒市场需求和公司经营表现。',
  },
  {
    name: '家电龙头财报',
    category: 'industry',
    description: '美的集团(000333)、格力电器(000651)财报',
    urls: [
      'http://www.cninfo.com.cn/new/disclosure/stock?stockCode=000333&orgId=gssz0000333',
      'http://www.cninfo.com.cn/new/disclosure/stock?stockCode=000651&orgId=gssz0000651',
    ],
    prompt: '请解读美的集团和格力电器最新财报，分析家电行业竞争格局和海外拓展情况。',
  },
  {
    name: '中国移动财报',
    category: 'industry',
    description: '中国移动(00941/600941)财报',
    urls: [
      'https://www.hkexnews.hk/index_c.htm',
    ],
    searchKeywords: ['00941'],
    prompt: '请解读中国移动最新财报，分析5G建设投入、用户增长和数字化转型进展。',
  },
  {
    name: '航空公司财报',
    category: 'industry',
    description: '中国国航(601111)等航空公司财报',
    urls: [
      'http://www.cninfo.com.cn/new/index',
    ],
    searchKeywords: ['601111'],
    prompt: '请解读主要航空公司最新财报，分析航空客运恢复情况和行业盈利前景。',
  },
];

const ALL_SOURCES = [...MACRO_SOURCES, ...INDUSTRY_SOURCES];

module.exports = { MACRO_SOURCES, INDUSTRY_SOURCES, ALL_SOURCES };
