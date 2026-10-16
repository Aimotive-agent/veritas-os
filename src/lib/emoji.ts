/*
 * The emoji picker's catalogue: the few hundred people actually reach for, each with its name and
 * search words. Pure data and search, unit-tested.
 */

export interface Emoji {
  char: string
  name: string
  keywords: string
  group: string
}

// One per line: emoji | name | extra search words. Groups start with "# Name".
const TABLE = `
# Smileys
😀|grinning face|happy smile
😃|grinning face with big eyes|happy joy
😄|grinning face with smiling eyes|happy laugh
😁|beaming face|grin happy
😆|laughing|lol haha
😅|grinning face with sweat|relief nervous
🤣|rolling on the floor laughing|rofl lol
😂|tears of joy|lol crying laughing
🙂|slightly smiling face|smile ok
😉|winking face|wink flirt
😊|smiling face with smiling eyes|blush happy
😇|smiling face with halo|angel innocent
🥰|smiling face with hearts|love adore
😍|heart eyes|love crush
🤩|star struck|wow excited
😘|face blowing a kiss|kiss love
😋|face savoring food|yum tasty
😜|winking face with tongue|silly joke
🤪|zany face|crazy silly
😎|smiling face with sunglasses|cool
🤓|nerd face|geek glasses
🧐|face with monocle|curious inspect
🤔|thinking face|hmm think
🤨|face with raised eyebrow|skeptical doubt
😐|neutral face|meh
😑|expressionless face|blank
😶|face without mouth|silent speechless
🙄|face with rolling eyes|eyeroll whatever
😏|smirking face|smirk sly
😬|grimacing face|awkward eek
🤥|lying face|liar pinocchio
😌|relieved face|calm content
😔|pensive face|sad thoughtful
😪|sleepy face|tired
🤤|drooling face|drool
😴|sleeping face|zzz sleep
😷|face with medical mask|sick mask
🤒|face with thermometer|ill fever
🤕|face with head bandage|hurt injured
🤢|nauseated face|sick gross
🤮|face vomiting|sick vomit
🥵|hot face|heat sweating
🥶|cold face|freezing
🥴|woozy face|dizzy drunk
😵|face with crossed out eyes|dizzy dead
🤯|exploding head|mind blown shocked
🤠|cowboy hat face|cowboy yeehaw
🥳|partying face|party celebrate birthday
😕|confused face|confused
😟|worried face|worried concerned
🙁|slightly frowning face|sad frown
😮|face with open mouth|wow surprised
😯|hushed face|surprised
😲|astonished face|shocked amazed
😳|flushed face|embarrassed blush
🥺|pleading face|please puppy eyes
😦|frowning face with open mouth|shocked
😧|anguished face|anguish
😨|fearful face|scared afraid
😰|anxious face with sweat|nervous anxious
😥|sad but relieved face|phew
😢|crying face|sad tear
😭|loudly crying face|sob crying
😱|face screaming in fear|scream horror
😖|confounded face|frustrated
😣|persevering face|struggle
😞|disappointed face|sad disappointed
😓|downcast face with sweat|hard work
😩|weary face|tired weary
😫|tired face|exhausted
🥱|yawning face|bored tired yawn
😤|face with steam from nose|triumph angry
😡|pouting face|angry mad
😠|angry face|angry mad
🤬|face with symbols on mouth|swearing cursing
😈|smiling face with horns|devil evil
💀|skull|dead dying lol
💩|pile of poo|poop
🤡|clown face|clown
👻|ghost|halloween boo
👽|alien|ufo space
🤖|robot|bot ai machine
😺|grinning cat|cat happy
😻|smiling cat with heart eyes|cat love
🙈|see no evil monkey|monkey shy oops
🙉|hear no evil monkey|monkey
🙊|speak no evil monkey|monkey secret
# Gestures
👋|waving hand|wave hello bye hi
🤚|raised back of hand|hand
✋|raised hand|stop high five
🖖|vulcan salute|spock live long
👌|ok hand|ok perfect
🤌|pinched fingers|italian
🤏|pinching hand|small tiny
✌️|victory hand|peace two
🤞|crossed fingers|luck hope
🤟|love you gesture|love
🤘|sign of the horns|rock metal
🤙|call me hand|call shaka
👈|backhand index pointing left|left point
👉|backhand index pointing right|right point
👆|backhand index pointing up|up point
👇|backhand index pointing down|down point
☝️|index pointing up|one point
👍|thumbs up|yes like good approve +1
👎|thumbs down|no dislike bad -1
✊|raised fist|fist power
👊|oncoming fist|punch bump
👏|clapping hands|clap applause bravo
🙌|raising hands|celebrate hooray praise
👐|open hands|hug
🤲|palms up together|pray please
🤝|handshake|deal agreement meeting
🙏|folded hands|please thanks pray namaste
✍️|writing hand|write
💅|nail polish|nails
💪|flexed biceps|strong muscle gym
🧠|brain|smart think mind
👀|eyes|look watching see
👁️|eye|look
👅|tongue|lick
👄|mouth|lips kiss
# Hearts
❤️|red heart|love like
🧡|orange heart|love
💛|yellow heart|love friendship
💚|green heart|love
💙|blue heart|love
💜|purple heart|love
🖤|black heart|love dark
🤍|white heart|love
🤎|brown heart|love
💔|broken heart|heartbreak sad
❣️|heart exclamation|love
💕|two hearts|love
💞|revolving hearts|love
💓|beating heart|love heartbeat
💗|growing heart|love
💖|sparkling heart|love
💘|heart with arrow|cupid love
💝|heart with ribbon|gift love
💯|hundred points|100 perfect score
💢|anger symbol|angry
💥|collision|boom explosion
💫|dizzy|star
💦|sweat droplets|water splash
💨|dashing away|wind fast
💬|speech balloon|chat message comment
💭|thought balloon|think
💤|zzz|sleep
# People
👶|baby|child newborn
🧒|child|kid
👦|boy|child
👧|girl|child
🧑|person|adult
👨|man|adult
👩|woman|adult
🧓|older person|elderly
👴|old man|grandpa
👵|old woman|grandma
🧑‍💻|technologist|developer coder programmer laptop
🧑‍🎓|student|graduate school
🧑‍🏫|teacher|professor
🧑‍⚕️|health worker|doctor nurse
🧑‍🍳|cook|chef
🧑‍🚀|astronaut|space
🦸|superhero|hero
🧙|mage|wizard magic
🙋|person raising hand|question hi
🤷|person shrugging|shrug dunno whatever
🤦|person facepalming|facepalm ugh
🙇|person bowing|sorry thanks
🏃|person running|run exercise fast
💃|woman dancing|dance party
🕺|man dancing|dance party
👯|people with bunny ears|party dance
🧘|person in lotus position|yoga meditate calm
🛌|person in bed|sleep rest
👪|family|parents kids
# Animals
🐶|dog face|dog puppy pet
🐱|cat face|cat kitten pet
🐭|mouse face|mouse
🐹|hamster|pet
🐰|rabbit face|bunny
🦊|fox|animal
🐻|bear|animal
🐼|panda|animal
🐨|koala|australia animal
🐯|tiger face|animal
🦁|lion|animal king
🐮|cow face|animal
🐷|pig face|animal
🐸|frog|animal
🐵|monkey face|animal
🐔|chicken|bird
🐧|penguin|bird linux
🐦|bird|tweet
🦉|owl|bird wise night
🦅|eagle|bird
🦆|duck|bird
🐺|wolf|animal
🐴|horse face|animal
🦄|unicorn|magic
🐝|honeybee|bee buzz
🐛|bug|insect caterpillar
🦋|butterfly|insect pretty
🐌|snail|slow
🐞|lady beetle|ladybug
🐢|turtle|slow tortoise
🐍|snake|python
🦖|t-rex|dinosaur
🐙|octopus|sea
🦀|crab|rust sea
🐠|tropical fish|fish sea
🐬|dolphin|sea
🐳|spouting whale|whale docker sea
🦈|shark|sea
🐘|elephant|animal
🦒|giraffe|animal
🦔|hedgehog|animal
🐾|paw prints|pet
🌵|cactus|plant desert
🌲|evergreen tree|tree forest
🌳|deciduous tree|tree
🌴|palm tree|tropical beach
🌱|seedling|plant grow sprout
🌿|herb|plant leaf
🍀|four leaf clover|luck
🍁|maple leaf|autumn fall canada
🌸|cherry blossom|flower spring
🌹|rose|flower love
🌻|sunflower|flower summer
🌷|tulip|flower
# Food
🍏|green apple|fruit
🍎|red apple|fruit
🍐|pear|fruit
🍊|tangerine|orange fruit
🍋|lemon|fruit sour
🍌|banana|fruit
🍉|watermelon|fruit summer
🍇|grapes|fruit wine
🍓|strawberry|fruit
🍒|cherries|fruit
🍑|peach|fruit
🥭|mango|fruit
🍍|pineapple|fruit
🥥|coconut|fruit
🥑|avocado|fruit guacamole
🍅|tomato|vegetable
🥕|carrot|vegetable
🌽|corn|vegetable
🌶️|hot pepper|spicy chili
🥦|broccoli|vegetable
🍄|mushroom|fungi
🍞|bread|toast bakery
🥐|croissant|bakery french
🧀|cheese|food
🥚|egg|breakfast
🍳|cooking|egg breakfast fry
🥞|pancakes|breakfast
🥓|bacon|breakfast
🍔|hamburger|burger fast food
🍟|french fries|fries chips
🍕|pizza|food
🌭|hot dog|food
🥪|sandwich|lunch
🌮|taco|mexican
🌯|burrito|mexican
🥗|green salad|salad healthy
🍝|spaghetti|pasta italian
🍜|steaming bowl|noodles ramen soup
🍣|sushi|japanese fish
🍱|bento box|japanese lunch
🍦|soft ice cream|ice cream dessert
🍩|doughnut|donut dessert
🍪|cookie|biscuit dessert
🎂|birthday cake|cake party
🍰|shortcake|cake dessert
🧁|cupcake|cake dessert
🍫|chocolate bar|chocolate sweet
🍿|popcorn|movie snack
☕|hot beverage|coffee tea
🍵|teacup without handle|tea green matcha
🧋|bubble tea|boba
🥤|cup with straw|soda drink
🍺|beer mug|beer drink cheers
🍻|clinking beer mugs|cheers beer
🍷|wine glass|wine drink
🥂|clinking glasses|cheers champagne celebrate
🍸|cocktail glass|cocktail drink
# Activities
⚽|soccer ball|football sport
🏀|basketball|sport
🏈|american football|sport
⚾|baseball|sport
🎾|tennis|sport
🏐|volleyball|sport
🏓|ping pong|table tennis sport
🏸|badminton|sport
🥊|boxing glove|sport fight
🎯|bullseye|target goal dart
⛳|flag in hole|golf
🎣|fishing pole|fish
🎿|skis|ski snow
🏂|snowboarder|snow
🏋️|person lifting weights|gym workout
🚴|person biking|bike cycling
🏆|trophy|win award prize champion
🥇|first place medal|gold winner
🥈|second place medal|silver
🥉|third place medal|bronze
🎮|video game|controller gaming play
🕹️|joystick|game arcade
🎲|game die|dice game
🧩|puzzle piece|jigsaw
♟️|chess pawn|chess
🎨|artist palette|art paint design
🎬|clapper board|movie film
🎤|microphone|sing karaoke
🎧|headphone|music listen audio
🎵|musical note|music song
🎶|musical notes|music song
🎸|guitar|music rock
🎹|musical keyboard|piano music
🥁|drum|music
🎉|party popper|celebrate tada party congrats
🎊|confetti ball|celebrate party
🎁|wrapped gift|present birthday
🎈|balloon|party birthday
🎄|christmas tree|xmas holiday
🎃|jack-o-lantern|halloween pumpkin
✨|sparkles|magic shiny new clean
🔥|fire|hot lit flame
⭐|star|favourite favorite
🌟|glowing star|star shine
⚡|high voltage|lightning fast electric power
☀️|sun|sunny weather
🌤️|sun behind small cloud|weather
⛅|sun behind cloud|cloudy weather
☁️|cloud|weather cloudy
🌧️|cloud with rain|rain weather
⛈️|cloud with lightning and rain|storm weather
❄️|snowflake|snow cold winter
☃️|snowman|snow winter
🌈|rainbow|pride colours
🌙|crescent moon|night moon sleep
🌍|globe showing europe-africa|earth world
🌎|globe showing americas|earth world
🌏|globe showing asia-australia|earth world
# Travel
🚗|automobile|car drive
🚕|taxi|car cab
🚌|bus|transport
🚑|ambulance|emergency
🚒|fire engine|truck
🚲|bicycle|bike
🛵|motor scooter|scooter
🚂|locomotive|train
🚆|train|transport rail
✈️|airplane|plane flight travel
🚀|rocket|launch space ship fast
🛸|flying saucer|ufo
🚢|ship|boat cruise
⛵|sailboat|boat
⚓|anchor|ship sea
🗺️|world map|map travel
🧭|compass|navigation direction
🏠|house|home
🏡|house with garden|home
🏢|office building|work office
🏥|hospital|health
🏫|school|education
🏰|castle|palace
🗽|statue of liberty|new york
🗼|tokyo tower|japan
🏖️|beach with umbrella|beach holiday vacation
🏔️|snow-capped mountain|mountain
🏕️|camping|tent outdoors
⛺|tent|camping
🌋|volcano|mountain
# Objects
⌚|watch|time clock
📱|mobile phone|phone iphone android
💻|laptop|computer mac work
🖥️|desktop computer|computer monitor pc
⌨️|keyboard|type computer
🖱️|computer mouse|mouse click
🖨️|printer|print
💾|floppy disk|save
💿|optical disk|cd
📷|camera|photo picture
📸|camera with flash|photo selfie
🎥|movie camera|film video
📺|television|tv screen
📻|radio|music
🔋|battery|power charge
🔌|electric plug|power charge
💡|light bulb|idea tip
🔦|flashlight|torch light
🕯️|candle|light
🧯|fire extinguisher|safety
💸|money with wings|spend money
💵|dollar banknote|money cash
💰|money bag|money rich
💳|credit card|pay card money
💎|gem stone|diamond jewel
⚖️|balance scale|law justice
🔧|wrench|tool fix settings
🔨|hammer|tool build fix
⚙️|gear|settings cog config
🛠️|hammer and wrench|tools build fix
🧰|toolbox|tools
🔩|nut and bolt|hardware
🧲|magnet|attract
🧪|test tube|science lab experiment test
🔬|microscope|science
🔭|telescope|space astronomy
💊|pill|medicine health
💉|syringe|vaccine health
🩺|stethoscope|doctor health
🧹|broom|clean sweep
🧺|basket|laundry
🧻|roll of paper|toilet paper
🧼|soap|clean wash
🛒|shopping cart|shop buy
🎒|backpack|school bag
👓|glasses|eyeglasses read
🕶️|sunglasses|cool
👕|t-shirt|clothes shirt
👖|jeans|clothes pants
👗|dress|clothes
👟|running shoe|sneaker shoe
👑|crown|king queen royal
🎓|graduation cap|graduate school university
✉️|envelope|email mail letter
📧|e-mail|email mail
📨|incoming envelope|email inbox
📦|package|box parcel delivery ship
📮|postbox|mail
📝|memo|note write todo
📄|page facing up|document file
📃|page with curl|document
📑|bookmark tabs|tabs
📊|bar chart|chart stats data graph
📈|chart increasing|growth up trend stocks
📉|chart decreasing|down trend loss
📅|calendar|date schedule
📆|tear-off calendar|date schedule
🗓️|spiral calendar|date plan
📇|card index|contacts
📋|clipboard|copy paste list
📌|pushpin|pin location
📍|round pushpin|pin location place
📎|paperclip|attach attachment
✂️|scissors|cut
🖊️|pen|write
✏️|pencil|write edit draw
🔍|magnifying glass tilted left|search find zoom
🔎|magnifying glass tilted right|search find zoom
🔒|locked|lock secure private
🔓|unlocked|unlock open
🔑|key|password unlock login
🗝️|old key|key
🔐|locked with key|secure
🛡️|shield|security protect
📚|books|read library study
📖|open book|read
🔗|link|url chain
🧾|receipt|invoice bill
🗑️|wastebasket|trash delete bin
⏰|alarm clock|alarm wake time
⏳|hourglass not done|wait time loading
⌛|hourglass done|time done
⏱️|stopwatch|timer time
🔔|bell|notification alert ring
🔕|bell with slash|mute silent quiet
📣|megaphone|announce loud
📢|loudspeaker|announce
🏁|chequered flag|finish race done
🚩|triangular flag|flag warning
🏳️|white flag|surrender
🏳️‍🌈|rainbow flag|pride lgbt
# Symbols
✅|check mark button|done yes ok complete
☑️|check box with check|done tick
✔️|check mark|done yes tick
❌|cross mark|no wrong delete cancel
❎|cross mark button|no
➕|plus|add
➖|minus|subtract
✖️|multiply|times
➗|divide|division
❓|red question mark|question help
❔|white question mark|question
❗|red exclamation mark|important warning
❕|white exclamation mark|important
‼️|double exclamation mark|important
⚠️|warning|alert caution
🚫|prohibited|no forbidden ban
⛔|no entry|stop forbidden
🔴|red circle|red dot status
🟠|orange circle|orange dot
🟡|yellow circle|yellow dot
🟢|green circle|green dot online status
🔵|blue circle|blue dot
🟣|purple circle|purple dot
⚫|black circle|black dot
⚪|white circle|white dot
🟥|red square|red
🟩|green square|green
🟦|blue square|blue
⬛|black large square|black
⬜|white large square|white
🔺|red triangle pointed up|up
🔻|red triangle pointed down|down
💠|diamond with a dot|diamond
🔷|large blue diamond|diamond
🔶|large orange diamond|diamond
♻️|recycling symbol|recycle green
⚛️|atom symbol|science react
🆕|new button|new
🆗|ok button|ok
🆒|cool button|cool
🆓|free button|free
🔝|top arrow|top
🔜|soon arrow|soon
⬆️|up arrow|up
⬇️|down arrow|down
⬅️|left arrow|left back
➡️|right arrow|right next
↩️|right arrow curving left|undo back reply
↪️|left arrow curving right|redo forward
🔄|counterclockwise arrows button|refresh sync reload
🔃|clockwise vertical arrows|refresh reload
▶️|play button|play start
⏸️|pause button|pause
⏹️|stop button|stop
⏺️|record button|record
⏭️|next track button|next skip
⏮️|last track button|previous back
🔀|shuffle tracks button|shuffle random
🔁|repeat button|repeat loop
🔊|speaker high volume|loud sound audio
🔇|muted speaker|mute silent
©️|copyright|copyright
®️|registered|trademark
™️|trade mark|trademark
#️⃣|keycap number sign|hash pound
0️⃣|keycap 0|zero number
1️⃣|keycap 1|one number
2️⃣|keycap 2|two number
3️⃣|keycap 3|three number
🔟|keycap 10|ten number
`

function parse(table: string): Emoji[] {
  const out: Emoji[] = []
  let group = 'Smileys'

  for (const line of table.split('\n')) {
    if (!line.trim()) {
      continue
    }

    if (line.startsWith('# ')) {
      group = line.slice(2).trim()

      continue
    }

    const [char, name, keywords = ''] = line.split('|')

    if (char && name) {
      out.push({ char, name, keywords, group })
    }
  }

  return out
}

export const EMOJI: readonly Emoji[] = parse(TABLE)

export const EMOJI_GROUPS: readonly string[] = [...new Set(EMOJI.map(emoji => emoji.group))]

/** Best matches first: a name that starts with the query, then a word in the name, then a keyword. */
export function searchEmoji(query: string, limit = 80): Emoji[] {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean)

  if (words.length === 0) {
    return EMOJI.slice(0, limit)
  }

  const scored: { emoji: Emoji; score: number }[] = []

  for (const emoji of EMOJI) {
    const name = emoji.name.toLowerCase()
    const haystack = `${name} ${emoji.keywords.toLowerCase()}`
    let score = 0

    for (const word of words) {
      if (name.startsWith(word)) {
        score += 3
      } else if (name.split(/[\s-]+/).some(part => part.startsWith(word))) {
        score += 2
      } else if (haystack.split(/[\s-]+/).some(part => part.startsWith(word))) {
        score += 1
      } else {
        score = 0

        break
      }
    }

    if (score > 0) {
      scored.push({ emoji, score })
    }
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(entry => entry.emoji)
}
