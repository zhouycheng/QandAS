CREATE TABLE IF NOT EXISTS user_settings (
 user_id uuid PRIMARY KEY REFERENCES user_account(id) ON DELETE CASCADE,
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 auto_open_analysis boolean NOT NULL, auto_next_when_correct boolean NOT NULL,
 option_outline boolean NOT NULL, vibrate_on_answer boolean NOT NULL,
 font_size varchar(8) NOT NULL CHECK(font_size IN ('small','normal','large','xlarge','xxlarge')),
 module_order text[] NOT NULL CHECK(cardinality(module_order)=4 AND module_order @> ARRAY['info','stem','response','tools']),
 layout_mode varchar(8) NOT NULL CHECK(layout_mode IN ('flow','custom')),
 practice_stem_percent integer NOT NULL CHECK(practice_stem_percent BETWEEN 30 AND 70 AND practice_stem_percent%5=0),
 swipe_enabled boolean NOT NULL, swipe_draft_action varchar(8) NOT NULL CHECK(swipe_draft_action IN ('save','confirm'))
);
CREATE TABLE IF NOT EXISTS user_exam_countdown (
 user_id uuid NOT NULL REFERENCES user_settings(user_id) ON DELETE CASCADE,
 id varchar(100) NOT NULL, exam_name varchar(20) NOT NULL CHECK(char_length(exam_name)>0),
 exam_date date NOT NULL, position integer NOT NULL CHECK(position>=0),
 PRIMARY KEY(user_id,id), UNIQUE(user_id,position)
);
CREATE TABLE IF NOT EXISTS user_practice_preset (
 user_id uuid NOT NULL REFERENCES user_settings(user_id) ON DELETE CASCADE,
 id varchar(100) NOT NULL, name varchar(30) NOT NULL CHECK(char_length(name)>0),
 mode varchar(8) NOT NULL CHECK(mode IN ('practice','test','view')),
 feedback varchar(16) NOT NULL CHECK(feedback IN ('IMMEDIATE','AFTER_FINISH')),
 question_order varchar(8) NOT NULL CHECK(question_order IN ('order','random')),
 question_count integer CHECK(question_count BETWEEN 1 AND 1000),
 duration integer NOT NULL CHECK(duration BETWEEN 0 AND 1440),
 is_default boolean NOT NULL, position integer NOT NULL CHECK(position>=0),
 PRIMARY KEY(user_id,id), UNIQUE(user_id,position)
);
CREATE UNIQUE INDEX IF NOT EXISTS user_practice_preset_default_idx ON user_practice_preset(user_id) WHERE is_default;
