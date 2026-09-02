// 片库筛选常量（数据本身来自后端 /api/catalog/*，这里只保留 UI 用的静态选项）

export const GENRE_LIST = ['全部', '剧情', '喜剧', '动作', '爱情', '科幻', '悬疑', '动画', '奇幻', '恐怖', '犯罪', '历史', '战争', '纪录片', '冒险', '古装'];

export const REGION_LIST = ['全部', '中国大陆', '中国香港', '中国台湾', '美国', '日本', '韩国', '英国', '法国', '其他'];

export const YEAR_LIST = ['全部', '2026', '2025', '2024', '2023', '2020-2022', '2010-2019', '经典老片'];

export const HOT_SEARCH_TERMS = ['沙丘', '流浪地球', '三体', '奥本海默', '繁花', '漫长的季节', '千与千寻', '切尔诺贝利'];

export const MEDIA_TYPE_LABELS: Record<string, string> = {
  movie: '电影',
  series: '剧集',
  anime: '动漫',
  doc: '纪录片',
};

/** 卡片角标用的类型名：剧集按题材细分出"综艺" */
export function typeLabel(movie: { type: string; genres?: string[] }): string {
  if (movie.type === 'anime') return '动漫';
  if (movie.type === 'doc') return '纪录片';
  if (movie.type === 'movie') return '电影';
  if ((movie.genres || []).some((g) => ['真人秀', '脱口秀', '综艺'].some((k) => g.includes(k)))) return '综艺';
  return '剧集';
}
