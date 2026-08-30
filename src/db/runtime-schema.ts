/**
 * Ordered migration identities required by this application image at runtime.
 *
 * Keep this module free of filesystem dependencies so it can be bundled into
 * the Next.js server. A unit test compares it with the migration journal and
 * SQL files, forcing every migration addition or edit to update this marker
 * deliberately.
 */
export const RUNTIME_SCHEMA_MIGRATIONS = [
  {
    tag: "0000_concerned_daimon_hellstrom",
    hash: "6ec2d3b7a0f3005909ba6872c3475dcba40a09e76b198c4eb65c6e8d7a4807bf",
    createdAt: 1781268743506,
  },
  {
    tag: "0001_cool_triathlon",
    hash: "36d3fc3031d55d75d307b0e0881a239fd0ba86f2b5c69345e776acc4f91f6c3e",
    createdAt: 1781272698859,
  },
  {
    tag: "0002_watery_praxagora",
    hash: "2e68b755c08f7af8e4d15c9c14c66adbff48ed52763b99c44e3d23235ea4e2fd",
    createdAt: 1781323270609,
  },
  {
    tag: "0003_user_locale",
    hash: "31e8851c3c2feea2c59a903f8b2109c8a4d8ef91adda01aaf7a9ef422b6671ca",
    createdAt: 1781426822030,
  },
  {
    tag: "0004_japanese_locale_foundation",
    hash: "9d4d050b0a257250034e03510b1bae4c6ce9bbed4ce12750320400e91b7fccaa",
    createdAt: 1781454827287,
  },
  {
    tag: "0005_content_i18n_model",
    hash: "831a3cd8809159b1afa07bdba61fccba8ab38aa944245935e97e43eaecb5465f",
    createdAt: 1781456823675,
  },
  {
    tag: "0006_whole_blazing_skull",
    hash: "3e34babc504caf84f66983f4e2fa1c73271a06c8c2069b3d1846b8517a856ecb",
    createdAt: 1781591637504,
  },
  {
    tag: "0007_long_mystique",
    hash: "fddcc3aeaf5e10232768b7456cca8ba7571722e1b11d180f1ee32a37aec78d84",
    createdAt: 1781769090836,
  },
  {
    tag: "0008_first_speed_demon",
    hash: "069a8ccf2b42d464ca97dd4136205b3df5b1532aafa1b25ae02f44a1bed6d3b7",
    createdAt: 1781774558637,
  },
  {
    tag: "0009_modern_absorbing_man",
    hash: "2fad41ac093d5a03bd25f9e9a324bf1f600a73dbfc625945ad4a552319fa757c",
    createdAt: 1781777593838,
  },
  {
    tag: "0010_nostalgic_killraven",
    hash: "c0fa6c00c066f2279782e72d06490dbd36f79b64ccdb92d41fb921b2be51ec76",
    createdAt: 1781805563343,
  },
  {
    tag: "0011_closed_wolfsbane",
    hash: "9492e6803e513d43df86395bdfebba25093d9da4d177f8ad82bc709ddaeaa99d",
    createdAt: 1781838240618,
  },
  {
    tag: "0012_unique_owl",
    hash: "96b6ac1e541866f73709d48fae540877fd6c0a00b2d6ad2bcbb88749384b4306",
    createdAt: 1781873320070,
  },
  {
    tag: "0013_wild_rafael_vega",
    hash: "a41a4d26ee6ed5ef38c6bca55636bd1e1db5ff5374d687752e4007596923155a",
    createdAt: 1781896870954,
  },
  {
    tag: "0014_red_jazinda",
    hash: "f9dc1cdee928b0492f9b633c7a15db1079749f41b08fbf19cf66d8b5dc422ab7",
    createdAt: 1782044175990,
  },
  {
    tag: "0015_furry_unicorn",
    hash: "8ad19474d6d7838364fc70776cfaa5309a30821cd6012bb58fda6ca02dbfa710",
    createdAt: 1782368171142,
  },
  {
    tag: "0016_tired_bishop",
    hash: "df99c0d4bdb3251004b517135caf592b8c29b53e8d0a0ae6a335b033d2064506",
    createdAt: 1782384870512,
  },
  {
    tag: "0017_cold_hellfire_club",
    hash: "87fcd7f93775a42b10a65a4089c96abfbbe09e1cedc6e13b9e1422009e8f9185",
    createdAt: 1782403506646,
  },
  {
    tag: "0018_file_reference_indexes",
    hash: "6664626354861922abfff7075c1f5b530b9a3c77b35b27914df2b6994191d335",
    createdAt: 1782919854267,
  },
  {
    tag: "0019_dear_the_order",
    hash: "984c7afb78bf9867ed7141218b10111dba2877eef150da9dca7015116a1792aa",
    createdAt: 1782936440384,
  },
  {
    tag: "0020_file_reference_integrity",
    hash: "7372a8e39d88ad13721899e92127e4a305e2d29cfca151a2b01e7d41e9050b39",
    createdAt: 1783100680408,
  },
  {
    tag: "0021_tired_human_fly",
    hash: "b576d2fcc34a08622ea878baea7927bf0383bef456f6c7b39fda6a982ed40670",
    createdAt: 1783361146258,
  },
  {
    tag: "0022_public_feed_index",
    hash: "af306ade7563a5be434c95cc68905bf6642bc812e6568d8db2931359c8d6b32f",
    createdAt: 1783900800000,
  },
  {
    tag: "0023_wp2_email_notifications",
    hash: "66141358dd14d5081f35923aad5f9f2a1cd95fa6f7867622a5d1980d8191eb48",
    createdAt: 1783908000000,
  },
  {
    tag: "0024_g1_transactional_email_privacy",
    hash: "4d097e3c14ae6dbe23eeb3d9495c4e86e31087f9849dda696fb8c8c6b526dc34",
    createdAt: 1783987200000,
  },
  {
    tag: "0025_notification_delivery_fencing",
    hash: "f2ee4cbada036233ce46f8dba87346d4165ed2bee6cfdabc1f951bf8a0e2cbe8",
    createdAt: 1784073600000,
  },
  {
    tag: "0026_wp5_supporter_wall",
    hash: "95439aecad5cb14616349db810e75633d076641e781dbd96b74d77b78cdb3942",
    createdAt: 1784160000000,
  },
  {
    tag: "0027_supporter_wall_admin_page_index",
    hash: "bb518361e98e857bb2fd8ab92446fb636f576185b817cb1fffad1f83ce204bfd",
    createdAt: 1784185262763,
  },
  {
    tag: "0028_wp1_magic_link",
    hash: "9dd7f920ff75f8cbedd68818f1593a23b30de61333f728e2fdb35e8dba151bc9",
    createdAt: 1784574204058,
  },
  {
    tag: "0029_wp2_oauth",
    hash: "02d25b7a08ade73677b01dfec83f51c908f3f108acd670c1ec8a63798b376ca7",
    createdAt: 1784610000000,
  },
  {
    tag: "0030_wp3_membership_entitlements",
    hash: "6645bbd066fa40553c6f179e061b47225c839f02c73d69ede1674a0f4438498b",
    createdAt: 1784661855608,
  },
  {
    tag: "0031_issue_184_magic_link_intake",
    hash: "4aa3fedb8877765e55806283bbd794de85b2d2110d84125063e94ff8c430d5b0",
    createdAt: 1786003765571,
  },
  {
    tag: "0032_issue_184_dead_intake_alerts",
    hash: "96c1703d636c9dddb8c3ca85f4e2bdc377faf7d41e48816744c049687e62fab7",
    createdAt: 1786005871971,
  },
  {
    tag: "0033_issue_184_mint_ledger_guards",
    hash: "5aa72672d70c60a3242292441855855ab168e1e61eacd2c286cb8a6702aa5d47",
    createdAt: 1786006155130,
  },
  {
    tag: "0034_issue_184_magic_link_payload_strictness",
    hash: "551200a332ec0435b101ac3faa8d7c91b7728d5cb49ed7092eb643d90b1d2c12",
    createdAt: 1786008053841,
  },
  {
    tag: "0035_solid_stepford_cuckoos",
    hash: "1a630175b39fcede7d9ab69ee92570b9356e670f10b214044c9e9a72b592ede7",
    createdAt: 1786507302997,
  },
  {
    tag: "0036_pretty_lester",
    hash: "b13e71b7d565f2e659960452883e4aa5d8335ff0ecdc4237b2b2b9efc8256daa",
    createdAt: 1786535708480,
  },
  {
    tag: "0037_peaceful_risque",
    hash: "845767d3e1dcbfcd7e7d1c553af62eb737cbfa924214da8bcd6fb7be0bf9bcda",
    createdAt: 1787206460655,
  },
  {
    tag: "0038_preset_tier_commerce",
    hash: "43e77545855b871f03a07751ccd53499ae4309ad12a7298e0fa77b37e99d1101",
    createdAt: 1788030397614,
  },
] as const;

export const RUNTIME_SCHEMA_MIGRATION = RUNTIME_SCHEMA_MIGRATIONS.at(-1)!;
