const qrcode = require("qrcode-terminal");
const fs = require("fs");
const axios = require("axios");
const express = require("express");
const path = require("path");
const util = require("util");
const stream = require("stream");
const sharp = require("sharp");
const pipeline = util.promisify(stream.pipeline);
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeInMemoryStore,
} = require("@whiskeysockets/baileys");

// Google Knowledge Graph Search API
let kgsearch;
try {
  const {kgsearch: kgs} = require('@googleapis/kgsearch');
  kgsearch = kgs('v1');
} catch (error) {
  console.log("❌ لم يتم تثبيت مكتبة Google Knowledge Graph. يمكن تثبيتها عن طريق: npm install @googleapis/kgsearch");
}

// تخزين بيانات الجلسة
const store = makeInMemoryStore({});
let isRestarting = false;
global.hasSentCommandList = false; // لتجنب تكرار إرسال قائمة الأوامر
const handledMessages = new Set();
const games = {}; // لتخزين الألعاب لكل شات
const messageCount = {}; // لتخزين عدد الرسائل لكل عضو
const activeQuizzes = {};
const userState = {}; // لتتبع حالة كل مستخدم (مثل: "culture" للثقافة، "prayer" للصلاة)

// تعيين حالة المستخدم مع وقت انتهاء صلاحية (لإعادة تعيين الحالة بعد فترة من عدم النشاط)
function setUserState(userId, chatId, state) {
  const stateKey = `${userId}_${chatId}`;
  userState[stateKey] = {
    state: state,
    expiry: Date.now() + (5 * 60 * 1000) // تنتهي صلاحية الحالة بعد 5 دقائق
  };

  // جدولة حذف الحالة بعد انتهاء الصلاحية
  setTimeout(() => {
    if (userState[stateKey] && userState[stateKey].expiry <= Date.now()) {
      delete userState[stateKey];
    }
  }, 5 * 60 * 1000);
}

// الحصول على حالة المستخدم الحالية
function getUserState(userId, chatId) {
  const stateKey = `${userId}_${chatId}`;
  if (userState[stateKey] && userState[stateKey].expiry > Date.now()) {
    return userState[stateKey].state;
  }
  return null; // لا توجد حالة أو انتهت صلاحيتها
}

// إعادة تعيين حالة المستخدم
function resetUserState(userId, chatId) {
  const stateKey = `${userId}_${chatId}`;
  delete userState[stateKey];
}

async function startBot() {
  try {
    console.log("📡 جاري تشغيل البوت...");
    console.log(`🕐 وقت البدء: ${new Date().toLocaleString("ar-EG")}`);

    // تحقق من وجود مجلد auth وإنشائه إذا لم يكن موجوداً
    if (!fs.existsSync("./auth")) {
      console.log("🔧 إنشاء مجلد auth لتخزين بيانات الجلسة...");
      fs.mkdirSync("./auth", { recursive: true });
    }

    // إنشاء مجلدات أخرى ضرورية
    if (!fs.existsSync("./temp")) {
      fs.mkdirSync("./temp", { recursive: true });
    }

    if (!fs.existsSync("./audio")) {
      fs.mkdirSync("./audio", { recursive: true });
    }

    if (!fs.existsSync("./stickers")) {
      fs.mkdirSync("./stickers", { recursive: true });
    }

    // إعدادات متقدمة للاتصال
    const { state, saveCreds } = await useMultiFileAuthState("auth");
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      syncFullHistory: true,
      connectTimeout: 60000, // مهلة الاتصال: دقيقة واحدة
      keepAliveIntervalMs: 25000, // إرسال نبض على فترات منتظمة للحفاظ على الاتصال
      markOnlineOnConnect: true, // تعيين الحالة إلى "متصل" تلقائياً
      browser: ["Chrome (Linux)", "Chrome", "10.0.0"], // معلومات المتصفح
      retryRequestDelayMs: 2000, // تأخير إعادة المحاولة
      transactionOpts: { maxCommitRetries: 5, delayBetweenTriesMs: 3000 }, // محاولات الالتزام
      defaultQueryTimeoutMs: 30000, // مهلة الاستعلام الافتراضية
    });

    store.bind(sock.ev);

    // متغيرات لتتبع حالة الاتصال
    let connectionRetryCount = 0;
    let lastQRTime = 0;
    let isConnected = false;

    sock.ev.on("connection.update", (update) => {
      const { qr, connection, lastDisconnect } = update;

      if (qr) {
        const currentTime = Date.now();
        // عرض رمز QR بفاصل زمني لتجنب إغراق وحدة التحكم
        if (currentTime - lastQRTime > 60000) {
          // عرض QR مرة واحدة كل دقيقة كحد أقصى
          console.log("📸 امسح كود QR باستخدام واتساب ويب:");
          qrcode.generate(qr, { small: true });
          lastQRTime = currentTime;
        }
      }

      if (connection === "open") {
        console.log("✅ تم الاتصال بنجاح!");
        isRestarting = false;
        isConnected = true;
        connectionRetryCount = 0; // إعادة تعيين عداد إعادة المحاولة

        // إرسال قائمة الأوامر مرة واحدة فقط عند التشغيل الأول
        if (!global.hasSentCommandList) {
          try {
            console.log("📋 محاولة إرسال قائمة الأوامر للمالك...");
            // إضافة تأخير قبل إرسال القائمة لضمان استقرار الاتصال
            setTimeout(async () => {
              try {
                const success = await sendCommandList(sock, sock.user.id);
                if (success) {
                  global.hasSentCommandList = true;
                  console.log("✅ تم إرسال قائمة الأوامر للمالك بنجاح");
                } else {
                  console.error("⚠️ فشل إرسال قائمة الأوامر للمالك");
                }
              } catch (innerError) {
                console.error("⚠️ خطأ أثناء إرسال قائمة الأوامر للمالك:", innerError);
              }
            }, 5000); // تأخير 5 ثوان بعد اتصال البوت
          } catch (e) {
            console.error("⚠️ خطأ في إعداد إرسال قائمة الأوامر:", e);
          }
        }
      }

      if (connection === "connecting") {
        console.log("🔄 جاري محاولة الاتصال...");
      }

      if (connection === "close") {
        isConnected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.output?.payload?.error;
        const message = lastDisconnect?.error?.message;

        console.log(
          `⚠️ انقطع الاتصال - الرمز: ${statusCode}, السبب: ${reason}, الرسالة: ${message}`,
        );

        // التعامل مع أسباب انقطاع الاتصال المختلفة
        if (statusCode === DisconnectReason.loggedOut) {
          console.log("❌ تم تسجيل خروج الجلسة، جاري محاولة إعادة الاتصال...");

          // حذف ملفات الجلسة المعطوبة فقط إذا كان ذلك ضرورياً واستبعاد أساسيات auth
          try {
            const authFiles = fs.readdirSync("./auth");
            for (const file of authFiles) {
              if (file.includes("session") && file.endsWith(".json")) {
                const filePath = `./auth/${file}`;
                // قراءة الملف للتحقق من صحته
                try {
                  JSON.parse(fs.readFileSync(filePath, "utf8"));
                } catch (e) {
                  // حذف الملف المعطوب فقط
                  console.log(`🗑️ حذف ملف جلسة معطوب: ${file}`);
                  fs.unlinkSync(filePath);
                }
              }
            }
          } catch (e) {
            console.error("❌ خطأ أثناء معالجة ملفات الجلسة:", e);
          }

          // محاولة إعادة الاتصال بعد تأخير
          setTimeout(() => {
            if (!isRestarting) {
              isRestarting = true;
              startBot();
            }
          }, 10000);
          return;
        }

        // استراتيجية إعادة المحاولة المتدرجة
        if (!isRestarting) {
          connectionRetryCount++;

          // زيادة وقت الانتظار مع زيادة عدد المحاولات الفاشلة
          const retryDelay = Math.min(
            5000 * Math.pow(1.5, connectionRetryCount - 1),
            60000,
          ); // بحد أقصى دقيقة واحدة

          console.log(
            `🔄 محاولة إعادة الاتصال #${connectionRetryCount} بعد ${retryDelay / 1000} ثوانٍ...`,
          );

          isRestarting = true;
          setTimeout(() => {
            startBot();
          }, retryDelay);
        }
      }
    });

    // معالجة تحديثات بيانات الاعتماد بشكل أكثر مرونة
    sock.ev.on("creds.update", async () => {
      try {
        await saveCreds();
        console.log("💾 تم حفظ بيانات الاعتماد");
      } catch (e) {
        console.error("⚠️ خطأ في حفظ بيانات الاعتماد:", e);
      }
    });

    // إضافة معالج لحالة الاتصال للكشف عن قطع الاتصال
    setInterval(() => {
      if (!isConnected && !isRestarting) {
        console.log("⚠️ الكشف عن انقطاع الاتصال في فحص الحالة الدوري");
        isRestarting = true;
        setTimeout(startBot, 5000);
      }
    }, 60000); // فحص كل دقيقة

    sock.ev.on("messages.upsert", async ({ messages }) => {
      const msg = messages[0];
      if (!msg.message) return;

      const chatId = msg.key.remoteJid;
      const senderId = msg.key.participant || msg.key.remoteJid;

      // تحديث عدد الرسائل لكل عضو
      if (!messageCount[senderId]) {
        messageCount[senderId] = 0;
      }
      messageCount[senderId]++;

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        msg.message?.documentMessage?.caption ||
        "";

      console.log(`📩 رسالة جديدة من ${senderId}: ${text}`);

      // التعامل مع رسائل الوسائط للتحويل إلى ملصق
      if (msg.message.imageMessage && text.includes(".ملصق")) {
        try {
          // إضافة رياكشن انتظار على رسالة المستخدم
          await sock.sendMessage(
            chatId, 
            { react: { key: msg.key, text: "⏳" }}
          );
          
          // استيراد دالة تنزيل الرسائل
          const { downloadMediaMessage } = require("@whiskeysockets/baileys");
          
          const buffer = await downloadMediaMessage(
            msg,
            'buffer',
            {},
            { 
              logger: console,
              reuploadRequest: sock.updateMediaMessage
            }
          );

          // تأكد من وجود مجلد stickers
          if (!fs.existsSync("./stickers")) {
            fs.mkdirSync("./stickers", { recursive: true });
          }

          const stickerPath = `./stickers/sticker_${Date.now()}.webp`;

          await sharp(buffer)
            .resize(512, 512)
            .toFormat('webp')
            .webp({ quality: 80 })
            .toFile(stickerPath);

          await sock.sendMessage(chatId, { 
            sticker: { url: stickerPath } 
          });

          // تغيير الرياكشن إلى علامة تمام
          await sock.sendMessage(
            chatId, 
            { react: { key: msg.key, text: "✅" }}
          );

          // حذف الملف بعد الإرسال
          setTimeout(() => {
            try {
              if (fs.existsSync(stickerPath)) {
                fs.unlinkSync(stickerPath);
                console.log(`🗑️ تم حذف الملف المؤقت: ${stickerPath}`);
              }
            } catch (err) {
              console.error(`⚠️ خطأ في حذف الملف المؤقت: ${err.message}`);
            }
          }, 5000);

          return;
        } catch (error) {
          console.error("❌ خطأ في تحويل الصورة إلى ملصق:", error);
          // تغيير الرياكشن إلى علامة خطأ
          await sock.sendMessage(
            chatId, 
            { react: { key: msg.key, text: "❌" }}
          );
          
          await sock.sendMessage(chatId, { 
            text: "❌ حدث خطأ أثناء تحويل الصورة إلى ملصق. حاول مرة أخرى." 
          });
        }
      }

      if (!text) return;

      const command = text.trim().toLowerCase();
      
      // التحقق من الأوامر المتعلقة بالعشرين/2025
      if (command.includes("2025") || command.includes("٢٠٢٥") || command.includes("العشرين")) {
        // إضافة رياكشن على رسالة المستخدم
        await sock.sendMessage(
          chatId, 
          { react: { key: msg.key, text: "🔒" }}
        );
        await sock.sendMessage(chatId, {
          text: "⛔ لا يمكنك استخدام هذا الأمر. هذه الأوامر محجوزة لإدارة البوت فقط.",
        });
        return;
      }

      const commands = {
        اهلا: "👋 أهلاً وسهلاً!",
        مين: "👋 انا بوت ذكاء اصطناعي لمساعده صاحب الرقم اذا كنت تريده ارسل كلمه خاص ",
        مرحبا: "😊 مرحبًا! كيف يمكنني مساعدتك؟",
        "كيف حالك": "أنا بخير، شكرًا لسؤالك! 😊 وأنت؟",
        "من انتم": "نحن فريق one Team هنا لدعمك في اي وقت 😊 وأنت؟",
        "one team":
          "نحن شركه او مؤسسه لدعم المتعلمين او الخريجين لايجاد الطريق الذي يحتاجه الشخص لسلوك مسعاه او مبتغاه 😊 وأنت؟",
        خاص: "سيتم التواصل معك في اقرب وقت الرجاء الأنتظار😊",
        بوت: `👋 مرحباً! أنا بوت واتساب ذكي متعدد المهام 🤖

💡 يمكنني مساعدتك في:
• تنزيل الفيديوهات من مواقع التواصل
• إنشاء ملصقات من الصور وتحويل الملصقات إلى صور
• تحويل النص إلى صوت
• الإجابة على أسئلتك باستخدام ".بوت + سؤالك"
• إدارة المجموعات ومساعدة المشرفين
• وأكثر من ذلك بكثير!

📋 اكتب ".اوامر" لمعرفة كل ما يمكنني فعله

🔰 تم تطويري بواسطة فريق One Team
`,
        ".بوت بحبك": "وأنا كمان بحبك كتير! 💚 دائماً جاهز لمساعدتك في أي وقت",
        اسمك: `✨ 𝕃𝕆𝕃 ✨ أنا بوت متعدد المهام طُورت بواسطة فريق One Team 🤖💫

أستطيع مساعدتك في العديد من الأمور مثل:
🌟 تحميل الفيديوهات
🌟 إنشاء الملصقات
🌟 الإجابة على استفساراتك
🌟 وأكثر!

يمكنك معرفة ما يمكنني فعله بكتابة ".اوامر" 📋`,
      };

      if (commands[command]) {
        // إضافة رياكشن قبل الرد
        await sock.sendMessage(
          chatId, 
          { react: { key: msg.key, text: "👀" }}
        );
        await sock.sendMessage(chatId, { text: commands[command] });
        // تغيير الرياكشن بعد الرد
        await sock.sendMessage(
          chatId, 
          { react: { key: msg.key, text: "👍" }}
        );
        return;
      }

      // منع تكرار معالجة نفس الرسالة
      const messageId = msg.key.id;
      if (handledMessages.has(messageId)) {
        console.log(`📝 تم تجاهل رسالة مكررة: ${messageId}`);
        return;
      }
      handledMessages.add(messageId);

      // تنظيف handledMessages دوريًا لمنع تضخمها
      if (handledMessages.size > 1000) {
        // الاحتفاظ بآخر 500 رسالة فقط
        const entriesToKeep = Array.from(handledMessages).slice(-500);
        handledMessages.clear();
        entriesToKeep.forEach(id => handledMessages.add(id));
      }

      // تحقق ما إذا كانت الرسالة تنفذ أمر سؤال بوت
      const isBotQuestion = (text.toLowerCase().includes("بوت") && (text.includes("؟") || text.endsWith("?"))) || text.startsWith(".بوت ");
      
      // إذا كانت الرسالة سؤال للبوت، فقم بمعالجتها كأمر سؤال وليس أوامر أخرى
      if (isBotQuestion) {
        // تمت معالجة الرسالة كسؤال، إضافة رياكشن انتظار
        await sock.sendMessage(
          chatId, 
          { react: { key: msg.key, text: "⏳" }}
        );
        
        try {
          // استخراج السؤال من النص
          let question = "";
          if (text.startsWith(".بوت ")) {
            question = text.replace(/\.بوت\s+/i, "").trim();
          } else {
            question = text.replace(/بوت/gi, "").trim();
          }

          // قائمة موسعة بالأسئلة والإجابات المعدة مسبقًا
          const predefinedQuestions = {
            "ما هو أفضل برنامج للتواصل الاجتماعي": "في رأيي، أفضل برنامج للتواصل الاجتماعي يعتمد على احتياجاتك. واتساب ممتاز للمحادثات، وتويتر للأخبار، وانستغرام للصور، وتيك توك للفيديوهات القصيرة، وفيسبوك للتواصل مع الأصدقاء والعائلة. 📱✨",
            "كم عمرك": "أنا بوت ذكاء اصطناعي، تم إنشائي حديثًا لخدمتك! لا أملك عمرًا محددًا مثل البشر، ولكني أتطور وأتعلم باستمرار. 🤖⚡",
            "ما هي أفضل لغة برمجة": "لا توجد لغة برمجة 'أفضل' بشكل مطلق! اختيار اللغة يعتمد على المشروع. Python مناسبة للمبتدئين، JavaScript للويب، Java للتطبيقات الشاملة، C++ للأداء العالي. الأفضل هي اللغة التي تحل مشكلتك بكفاءة. 💻🔍",
            "كيف أتعلم البرمجة": "لتعلم البرمجة، ابدأ بلغة سهلة مثل Python، استخدم منصات مثل Codecademy أو freeCodeCamp، حل مشاكل حقيقية تهمك، انضم لمجتمعات البرمجة، وتذكر أن الممارسة المستمرة هي مفتاح الإتقان! 🚀👨‍💻",
            "ما هو أفضل هاتف ذكي": "أفضل هاتف ذكي يختلف حسب احتياجاتك! آيفون ممتاز للنظام البيئي المتكامل، سامسونج للميزات المتقدمة والشاشات، جوجل بيكسل للكاميرا وتجربة أندرويد النقية. فكر في ميزانيتك واحتياجاتك قبل الاختيار. 📱⚡",
            "كيف أتعلم اللغة الإنجليزية": "لتعلم الإنجليزية: استمع لمحتوى أصلي (أفلام/موسيقى)، استخدم تطبيقات مثل Duolingo، مارس المحادثة مع متحدثين أصليين، اقرأ كتبًا بسيطة، احفظ كلمات جديدة يوميًا، وتذكر أن الاستمرارية هي المفتاح! 🌍📚",
            "ما هي عاصمة مصر": "عاصمة مصر هي القاهرة، وهي أكبر مدينة في العالم العربي وإفريقيا، وتعتبر مركزًا ثقافيًا وسياسيًا هامًا في المنطقة. تأسست عام 969 ميلادية، وتضم العديد من المعالم التاريخية مثل الأهرامات والمتحف المصري والقلعة وخان الخليلي. 🇪🇬🏙️",
            "من هو مخترع الهاتف": "مخترع الهاتف هو ألكسندر جراهام بيل، الذي سجل براءة اختراعه في عام 1876. كان بيل عالمًا اسكتلنديًا أمريكيًا عمل أيضًا في مجالات التعليم والطيران. ابتكر الهاتف أثناء محاولته تطوير جهاز لمساعدة الصم، حيث كان معلماً للصم وكانت زوجته أيضاً من الصم. ☎️🔍",
            "كم عدد كواكب المجموعة الشمسية": "المجموعة الشمسية تتكون من 8 كواكب رسمية: عطارد، الزهرة، الأرض، المريخ، المشتري، زحل، أورانوس، ونبتون. بلوتو تم إعادة تصنيفه ككوكب قزم في عام 2006. يُعتبر المشتري أكبر كواكب المجموعة الشمسية، بينما عطارد هو أصغرها وأقربها للشمس. 🪐🌌",
            "ما هو أكبر محيط في العالم": "المحيط الهادئ هو أكبر وأعمق محيط في العالم، يغطي مساحة تبلغ حوالي 165.2 مليون كيلومتر مربع، أي حوالي ثلث سطح الأرض. يحده قارات آسيا وأستراليا من الغرب والأمريكتين من الشرق، ويحتوي على أعمق نقطة في قاع البحار (خندق ماريانا) التي يبلغ عمقها حوالي 11 كيلومترًا. 🌊🌏",
            "كيف أحافظ على صحتي": "للحفاظ على صحتك: تناول طعامًا متوازنًا، مارس الرياضة بانتظام (150 دقيقة أسبوعيًا)، نم 7-8 ساعات، اشرب كثيرًا من الماء، قلل التوتر، تجنب التدخين والكحول، وقم بفحوصات طبية دورية. أيضاً، حافظ على صحتك العقلية من خلال ممارسة التأمل وتخصيص وقت للأنشطة التي تحبها. الصحة كنز! 💪🥗",
            "ما هو أطول نهر في العالم": "نهر النيل هو أطول نهر في العالم، يبلغ طوله حوالي 6,650 كيلومترًا. يمر عبر 11 دولة أفريقية ويصب في البحر المتوسط. يُعتبر النيل حيوياً للحضارة المصرية القديمة والحديثة، وكان يُطلق عليه 'هبة مصر' نظراً لدوره في الزراعة والحياة في المنطقة. 🌊🌍",
            "ما هي مصر": "مصر هي دولة عربية تقع في الركن الشمالي الشرقي من قارة أفريقيا، ولها امتداد آسيوي في شبه جزيرة سيناء. عاصمتها القاهرة، وتُعرف بأنها مهد الحضارة الفرعونية العريقة التي امتدت لأكثر من 5000 سنة. تضم مصر العديد من المعالم التاريخية أبرزها الأهرامات وأبو الهول والمعابد الفرعونية، وتتميز بموقع استراتيجي حيث تربط بين قارتي أفريقيا وآسيا، ويمر بها نهر النيل أطول أنهار العالم. 🇪🇬🏛️",
            "من هو محمد صلاح": "محمد صلاح هو لاعب كرة قدم مصري مشهور عالمياً، وُلد في 15 يونيو 1992 في قرية نجريج بمحافظة الغربية. يلعب حالياً مع نادي ليفربول الإنجليزي ومنتخب مصر. لُقّب بـ'الفرعون المصري' و'مو صلاح'، وحقق العديد من الإنجازات منها الفوز بدوري أبطال أوروبا والدوري الإنجليزي، وحصل على جائزة هداف الدوري الإنجليزي عدة مرات. يُعتبر صلاح رمزاً رياضياً ومصدر إلهام للشباب في العالم العربي. ⚽🇪🇬",
            "ما هي لغة البرمجة بايثون": "بايثون (Python) هي لغة برمجة عالية المستوى، سهلة التعلم، تتميز بقواعد بسيطة ومقروءة. طُورت في أواخر الثمانينات بواسطة غيدو فان روسوم، وسُميت على اسم فرقة مونتي بايثون الكوميدية. تستخدم في مجالات متعددة مثل تطوير الويب، الذكاء الاصطناعي، علم البيانات، وأتمتة المهام. تتميز بمكتبات غنية مثل NumPy وPandas وTensorFlow، ولها مجتمع داعم كبير. وهي من أكثر لغات البرمجة شعبية وطلباً في سوق العمل حالياً. 🐍💻",
            "كيف أتعلم القرآن": "لتعلم القرآن الكريم: ابدأ بتعلم قراءة الحروف العربية والتجويد الأساسي، استعن بمعلم مؤهل أو دورات متخصصة في المساجد أو عبر الإنترنت، استخدم تطبيقات تعليمية مثل 'القرآن المعلم'، خصص وقتاً يومياً للتلاوة والمراجعة، ابدأ بسور قصيرة مثل جزء عم، استمع لقراءات القراء المشهورين، شارك في حلقات تحفيظ، واستخدم المصحف الملون بأحكام التجويد. الاستمرارية والصبر مفتاح النجاح في رحلة تعلم كتاب الله. 📖🕌",
            "ما هي فوائد الرياضة": "الرياضة تقوي القلب والعضلات، تحسن المزاج بإطلاق هرمونات السعادة، تخفض خطر الإصابة بأمراض مزمنة مثل السكري والضغط، تحسن النوم، تزيد من الطاقة، تساعد في التحكم بالوزن، تقوي المناعة، وتعزز الثقة بالنفس. 30 دقيقة يومياً كافية للحصول على فوائد صحية كبيرة! 🏃‍♂️💪",
            "كيف أقلل من التوتر": "لتقليل التوتر: مارس التنفس العميق والتأمل، خصص وقتاً للاسترخاء، تمرن بانتظام، تناول غذاءً صحياً، احصل على قسط كافٍ من النوم، حدد أولوياتك، تعلم قول لا، ابتعد عن الكافيين والكحول، واعتن بهواية تحبها. تذكر أن طلب المساعدة من الأصدقاء أو المختصين ليس ضعفاً بل قوة. 😌🧘‍♂️",
            "ما هو الذكاء الاصطناعي": "الذكاء الاصطناعي هو فرع من علوم الحاسوب يهتم بإنشاء أنظمة قادرة على تنفيذ مهام تتطلب ذكاءً بشرياً، مثل التعلم واتخاذ القرارات وحل المشكلات والتعرف على الأنماط. يشمل تقنيات مثل تعلم الآلة والشبكات العصبية العميقة، ويستخدم في مجالات متعددة كالطب والتمويل والروبوتات والسيارات ذاتية القيادة. 🤖🧠",
            "كيف أنشئ موقع إلكتروني": "لإنشاء موقع إلكتروني: أولاً، حدد هدف موقعك وجمهورك. اختر اسم نطاق وخدمة استضافة مناسبة. يمكنك استخدام منصات سهلة مثل WordPress أو Wix للبدء دون برمجة، أو تعلم HTML، CSS، وJavaScript لبناء موقع من الصفر. اهتم بتصميم بسيط وسهل التصفح، واجعل موقعك متوافقاً مع الأجهزة المحمولة. لا تنسَ تحسين الموقع لمحركات البحث (SEO). 🌐💻"
          };

          // محاولة العثور على إجابة دقيقة
          let answer = null;
          
          // البحث عن تطابق دقيق أولاً
          if (predefinedQuestions[question]) {
            answer = predefinedQuestions[question];
          } 
          // إذا لم يوجد تطابق دقيق، ابحث عن تطابقات جزئية
          else {
            for (const [key, value] of Object.entries(predefinedQuestions)) {
              // تحقق إذا كان السؤال يحتوي على الكلمات الرئيسية
              if (
                question.includes(key) || 
                key.includes(question) ||
                key.split(" ").some(word => question.includes(word) && word.length > 3)
              ) {
                answer = value;
                break;
              }
            }
          }

          // إذا لم يجد إجابة محددة، حاول البحث باستخدام Google Knowledge Graph
          if (!answer && kgsearch) {
            try {
              // محاولة الحصول على إجابة من Google Knowledge Graph
              const kgResponse = await new Promise((resolve, reject) => {
                kgsearch.entities.search({
                  query: question,
                  limit: 1,
                  languages: ['ar', 'en'],
                  key: 'AIzaSyDTqHISvCOYWWQAFl_a98Fv39X0jM9vqzk' // استخدم مفتاح API الخاص بك هنا
                }, (err, response) => {
                  if (err) reject(err);
                  else resolve(response.data);
                });
              });
              
              if (kgResponse && kgResponse.itemListElement && kgResponse.itemListElement.length > 0 && 
                  kgResponse.itemListElement[0].result) {
                
                const entity = kgResponse.itemListElement[0].result;
                
                // تنسيق الرد من البيانات
                let kgAnswer = `📚 ${entity.name || 'موضوع البحث'}:\n\n`;
                
                if (entity.description) {
                  kgAnswer += `${entity.description}\n\n`;
                }
                
                if (entity.detailedDescription?.articleBody) {
                  kgAnswer += `${entity.detailedDescription.articleBody}\n\n`;
                }
                
                // إضافة معلومات إضافية إذا وجدت
                const detailsToAdd = [];
                
                if (entity.url) {
                  detailsToAdd.push(`🔗 للمزيد: ${entity.url}`);
                }
                
                if (detailsToAdd.length > 0) {
                  kgAnswer += detailsToAdd.join('\n');
                }
                
                answer = kgAnswer;
              }
            } catch (error) {
              console.error("❌ خطأ في البحث باستخدام Google Knowledge Graph:", error);
              // في حالة فشل API، استخدم الإجابة العامة
            }
          }

          // إذا لم يتم العثور على إجابة من قاعدة المعرفة أو Google، استخدم الإجابات العامة
          if (!answer) {
            const answers = [
              "أعتقد أن ذلك ممكن! يمكنك تجربته أو الاستعانة بالأوامر للمساعدة 😊",
              "بالتأكيد يمكنني محاولة مساعدتك في ذلك. جرب استخدام أحد أوامري المتاحة في '.اوامر'",
              "هذا سؤال جيد! أنا بوت بسيط ولكني أحاول المساعدة قدر الإمكان ✨",
              "أنا موجود هنا لمساعدتك! إذا كان سؤالك متعلقًا بإحدى وظائفي، فأنا سعيد بالمساعدة 🌟",
              "ممم، دعني أفكر... هذا سؤال مثير للاهتمام! يمكنك معرفة المزيد عن قدراتي بكتابة '.اوامر'",
              "أنا بوت متعدد المهام! يمكنني المساعدة في تنزيل الفيديوهات، إنشاء الملصقات، وأكثر من ذلك 🚀",
              "هذا سؤال جيد! للأسف ليس لدي معلومات كافية للإجابة عليه بدقة. يمكنك البحث عنه على الإنترنت للحصول على معلومات أكثر تفصيلاً.",
              "يبدو سؤالًا مثيرًا للاهتمام، لكن معرفتي محدودة في هذا المجال. يمكنك طرح أسئلة أخرى ربما أستطيع الإجابة عليها بشكل أفضل.",
              "أنا أحاول دائمًا مساعدتك قدر الإمكان، لكن هذا السؤال خارج نطاق معرفتي الحالية. هل هناك شيء آخر يمكنني مساعدتك به؟",
            ];

            // اختيار إجابة عشوائية من القائمة
            answer = answers[Math.floor(Math.random() * answers.length)];
          }

          // تغيير الرياكشن إلى علامة تمام
          await sock.sendMessage(
            chatId, 
            { react: { key: msg.key, text: "✅" }}
          );

          // إرسال الإجابة
          await sock.sendMessage(chatId, { text: answer });

        } catch (error) {
          console.error("❌ خطأ في معالجة السؤال:", error);
          
          // تغيير الرياكشن إلى علامة خطأ
          await sock.sendMessage(
            chatId, 
            { react: { key: msg.key, text: "❌" }}
          );
          
          await sock.sendMessage(chatId, { 
            text: "عذرًا، لم أتمكن من معالجة سؤالك. يمكنك المحاولة مرة أخرى أو طرح سؤال مختلف." 
          });
        }
        return;
      }

      // معالجة أوامر القوائم مع منع التكرار وإضافة تأخير بين الإرسال
      // القائمة الرئيسية للأوامر المتاحة (فئات فقط)
      if (command === ".اوامر") {
        // إضافة رياكشن على رسالة المستخدم
        await sock.sendMessage(
          chatId, 
          { react: { key: msg.key, text: "⏳" }}
        );
        // إعلام المستخدم بأن القائمة قادمة
        await sock.sendMessage(chatId, { text: "⏳ جاري تحضير قائمة فئات الأوامر..." });
        await new Promise(resolve => setTimeout(resolve, 1000)); // تأخير قبل إرسال القائمة الفعلية
        await sendCommandList(sock, chatId);
        // تغيير الرياكشن إلى علامة تمام بعد الانتهاء
        await sock.sendMessage(
          chatId, 
          { react: { key: msg.key, text: "✅" }}
        );
        return;
      }

      // فصل أوامر التنزيل
      if (command === ".اوامر_تنزيل") {
        // إضافة رياكشن على رسالة المستخدم
        await sock.sendMessage(
          chatId, 
          { react: { key: msg.key, text: "⏳" }}
        );
        await sock.sendMessage(chatId, { text: "⏳ جاري تحضير قائمة أوامر التنزيل..." });
        await new Promise(resolve => setTimeout(resolve, 1000));
        await sendDownloadCommands(sock, chatId);
        // تغيير الرياكشن بعد إرسال القائمة
        await sock.sendMessage(
          chatId, 
          { react: { key: msg.key, text: "✅" }}
        );
        return;
      }

      // فصل أوامر الإدارة
      if (command === ".اوامر_ادمن" || command === ".ادمنز") {
        await sock.sendMessage(chatId, { text: "⏳ جاري تحضير قائمة أوامر المشرفين..." });
        await new Promise(resolve => setTimeout(resolve, 1000));
        await sendAdminCommands(sock, chatId);
        return;
      }

      // فصل أوامر الدردشة
      if (command === ".اوامر_حوار") {
        await sock.sendMessage(chatId, { text: "⏳ جاري تحضير قائمة الردود التلقائية..." });
        await new Promise(resolve => setTimeout(resolve, 1000));
        await sendChatCommands(sock, chatId);
        return;
      }

      // إضافة قسم أوامر الوسائط المتعددة
      if (command === ".اوامر_وسائط") {
        await sock.sendMessage(chatId, { text: "⏳ جاري تحضير قائمة أوامر الوسائط..." });
        await new Promise(resolve => setTimeout(resolve, 1000));
        await sendMediaCommands(sock, chatId);
        return;
      }

      // إضافة قسم الأوامر العامة
      if (command === ".اوامر_عامة") {
        await sock.sendMessage(chatId, { text: "⏳ جاري تحضير قائمة الأوامر العامة..." });
        await new Promise(resolve => setTimeout(resolve, 1000));
        await sendGeneralCommands(sock, chatId);
        return;
      }

      // إضافة قسم أوامر الألعاب
      if (command === ".اوامر_العاب") {
        await sock.sendMessage(chatId, { text: "⏳ جاري تحضير قائمة ألعاب البوت..." });
        await new Promise(resolve => setTimeout(resolve, 1000));
        await sendGamesCommands(sock, chatId);
        return;
      }

      // الأوامر العامة
      if (command === ".وقت") {
        const now = new Date();
        const timeString = now.toLocaleTimeString("ar-EG", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
        await sock.sendMessage(chatId, {
          text: `🕒 الوقت الحالي: ${timeString}`,
        });
        return;
      }

      if (command === ".حكمه") {
        const wisdoms = [
          "💡 المال هو زينة الحياة الدنيا.",
          "🦉 العلم نور والجهل ظلام.",
          "🎯 لا تؤجل عمل اليوم إلى الغد.",
          "🎯 من أنجز سريعًا أخذ تاسكات كثيرة.",
          "🎯 استيقظ على الواقع، لا شيء يسير كما هو مخطط له في هذا العالم.",
          "🌱 من جد وجد، ومن زرع حصد.",
          "💡 الحكمة هي خلاصة الفكر.",
          "🦉 الحكيم هو من يعرف متى يتحدث ومتى يصمت.",
          "🎯 النجاح يأتي لمن يسعى إليه.",
          "🌱 الثقة بالنفس أساس النجاح.",
          "💡 الصبر مفتاح الفرج.",
          "🦉 التعلم من الأخطاء هو طريق النجاح.",
          "💡 لا تسأل عن شيء لا تريد سماع إجابته.",
          "🦉 النجاح ليس نهاية الطريق، بل هو بداية رحلة جديدة.",
          "🎯 افعل ما تستطيع بما لديك، حيثما كنت.",
          "🌱 الحياة ليست عن انتظار العاصفة لتمر، بل عن تعلم الرقص تحت المطر.",
        ];
        const randomWisdom =
          wisdoms[Math.floor(Math.random() * wisdoms.length)];
        await sock.sendMessage(chatId, { text: randomWisdom });
        return;
      }

      // تصحيح أمر المجموعة
      if (command === ".المجموعة") {
          try {
            // التحقق من أن الدردشة هي مجموعة
            if (!chatId.endsWith("@g.us")) {
              await sock.sendMessage(chatId, {
                text: "⚠️ هذا الأمر يعمل في المجموعات فقط!",
              });
              return;
            }

            // إضافة رياكشن على رسالة المستخدم
            await sock.sendMessage(
              chatId, 
              { react: { key: msg.key, text: "⏳" }}
            );

            // جلب بيانات المجموعة (هذا هو الاستخدام الأول)
            const groupMetadata = await sock.groupMetadata(chatId);
            const participants = groupMetadata.participants;
            const admins = participants.filter(p => p.admin).map(p => p.id);
            const isAdmin = admins.includes(senderId);

            if (!isAdmin) {
              await sock.sendMessage(chatId, {
                text: "⛔ هذا الأمر متاح للمشرفين فقط.",
              });
              return;
            }

            // هنا لا تحتاج إلى إعادة تعريف groupMetadata
            // جلب صورة المجموعة
            let profilePicture = "";
            try {
              profilePicture = await sock.profilePictureUrl(chatId, "image");
            } catch (err) {
              console.log("لا توجد صورة للمجموعة:", err);
              profilePicture =
                "https://via.placeholder.com/300?text=No+Group+Image"; // صورة افتراضية
            }

            // حساب عدد الرسائل المرسلة في المجموعة
            let totalMessages = 0;

            // حساب مجموع رسائل الأعضاء المتواجدين في المجموعة
            for (const participant of participants) {
              const participantId = participant.id;
              if (messageCount[participantId]) {
                totalMessages += messageCount[participantId];
              }
            }

            // إعداد رسالة المعلومات مع الزخرفة
            const infoMessage = `
          ┏━━━❮ 🏷️ *معلومات المجموعة* ❯━━━┓
          ┃ 📌 *الاسم:* ${groupMetadata.subject}
          ┃ 👥 *عدد الأعضاء:* ${participants.length}
          ┃ 👑 *عدد المشرفين:* ${admins.length}
          ┃ ✉️ *إجمالي الرسائل:* ${totalMessages}
          ┃ 📅 *تاريخ الإنشاء:* ${new Date(groupMetadata.creation * 1000).toLocaleDateString("ar-EG")}
          ┃ © *حقوق النشر:* ٢٠٢٥
          ┗━━━━━━━━━━━━━━━━━━━━┛
            `;

            console.log("إرسال معلومات المجموعة...");

            // إرسال المعلومات مع الصورة (إن وجدت)
            await sock.sendMessage(chatId, {
              image: { url: profilePicture },
              caption: infoMessage,
            });

            console.log("تم إرسال معلومات المجموعة بنجاح!");
            // تغيير الرياكشن إلى علامة تمام بعد الانتهاء
            await sock.sendMessage(
              chatId, 
              { react: { key: msg.key, text: "✅" }}
            );
          await sock.sendMessage(chatId, {
            text: "⚠️ حدث خطأ أثناء جلب معلومات المجموعة. الرجاء المحاولة مرة أخرى.",
          });
        
        return;

            

      if (command.startsWith(".صوت ")) {
        const text = command.replace(".صوت ", "").trim();
        if (!text) {
          await sock.sendMessage(chatId, {
            text: "⚠️ استخدم: .صوت [النص المراد تحويله لصوت]",
          });
          return;
        }

        // إنشاء رقم تعريف فريد لهذا الطلب لتجنب التداخل بين الطلبات المتزامنة
        const requestId = Date.now() + Math.floor(Math.random() * 1000);

        try {
          // إرسال رسالة انتظار
          await sock.sendMessage(chatId, {
            text: "⏳ جاري تحويل النص إلى صوت...",
          });

          // تنظيف النص من أي رموز قد تسبب مشاكل
          const cleanText = text.replace(
            /[^\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\u0030-\u0039\s\.,-]/g,
            " ",
          );

          // تقسيم النص إذا كان طويلاً (gTTS لها حد أقصى)
          const maxLength = 200;
          const textChunks = [];

          for (let i = 0; i < cleanText.length; i += maxLength) {
            textChunks.push(cleanText.substring(i, i + maxLength));
          }

          // استخدام النص الأول فقط إذا كان هناك أكثر من قسم
          const textToConvert = textChunks[0];
          console.log(`[${requestId}] النص للتحويل:`, textToConvert);

          // تأكد من إنشاء مجلد الصوتيات إذا لم يكن موجوداً
          if (!fs.existsSync("./audio")) {
            fs.mkdirSync("./audio", { recursive: true });
          }

          // تحديد اسم الملف بوضوح مع معرف الطلب
          const fileName = `audio_${requestId}.mp3`;
          const filePath = `./audio/${fileName}`;

          // استخدام مكتبة node-gtts
          const gTTS = require('node-gtts')('ar');

          // إضافة رياكشن لإظهار جاري التحويل
          await sock.sendMessage(
            chatId, 
            { react: { key: msg.key, text: "🔄" }}
          );

          // إنشاء الملف الصوتي بشكل مباشر باستخدام stream
          const fileStream = fs.createWriteStream(filePath);

          gTTS.stream(textToConvert)
            .pipe(fileStream)
            .on('finish', async () => {
              try {
                console.log(`[${requestId}] ✅ تم إنشاء الملف الصوتي بنجاح:`, filePath);

                // قراءة الملف واستخدام البيانات المخزنة في الذاكرة
                const audioData = fs.readFileSync(filePath);

                // إرسال الصوت
                await sock.sendMessage(chatId, {
                  audio: audioData,
                  mimetype: "audio/mp3",
                  ptt: true,
                  fileName: `صوت_${requestId}.mp3`, // اسم الملف المرئي للمستخدم
                });

                console.log(`[${requestId}] 📤 تم إرسال الصوت بنجاح!`);

                // حذف الملف بعد الإرسال
                try {
                  fs.unlinkSync(filePath);
                  console.log(`[${requestId}] 🗑️ تم حذف الملف المؤقت:`, filePath);
                } catch (deleteError) {
                  console.error(`[${requestId}] ⚠️ خطأ في حذف الملف المؤقت:`, deleteError);
                }
              } catch (error) {
                console.error(`[${requestId}] ❌ خطأ في إرسال الصوت:`, error);
                // تغيير الرياكشن إلى علامة خطأ
                await sock.sendMessage(
                  chatId, 
                  { react: { key: msg.key, text: "❌" }}
                );
                await sock.sendMessage(chatId, {
                  text: "❌ حدث خطأ أثناء إرسال الصوت. حاول مجددًا لاحقاً."
                });

                // التأكد من مسح الملف في حالة الفشل
                try {
                  if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                  }
                } catch (e) { /* تجاهل أخطاء الحذف */ }
              }
            })
            .on('error', async (error) => {
              console.error(`[${requestId}] ❌ خطأ في إنشاء الملف الصوتي:`, error);
              // تغيير الرياكشن إلى علامة خطأ
              await sock.sendMessage(
                chatId, 
                { react: { key: msg.key, text: "❌" }}
              );
              await sock.sendMessage(chatId, {
                text: "❌ تعذر تحويل النص إلى صوت. يرجى تبسيط النص أو المحاولة مرة أخرى لاحقاً."
              });

              // التأكد من مسح الملف في حالة الفشل
              try {
                if (fs.existsSync(filePath)) {
                  fs.unlinkSync(filePath);
                }
              } catch (e) { /* تجاهل أخطاء الحذف */ }
            });

        } catch (error) {
          console.error(
            `[${requestId}] ❌ خطأ خارجي في وظيفة تحويل النص إلى صوت:`,
            error,
          );
          await sock.sendMessage(chatId, {
            text: "❌ حدث خطأ أثناء معالجة طلبك. حاول مجددًا لاحقاً.",
          });
        }
        return;
      }

      if (command.startsWith(".صورة ")) {
        const query = command.replace(".صورة ", "").trim();
        if (!query) {
          await sock.sendMessage(chatId, {
            text: "⚠️ استخدم: .صورة [كلمة البحث]",
          });
          return;
        }

        try {
          const accessKey = "1d7s3Ck37fRYbuulS3BcyFnIhUv7bta71dseqRgJp5Y"; // استخدم Access Key الخاص بك
          const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&client_id=${accessKey}&per_page=10`;

          const response = await axios.get(url);
          const results = response.data.results;

          if (!results || results.length === 0) {
            throw new Error("❌ لم أتمكن من العثور على صور.");
          }

          // اختيار صورة عشوائية من النتائج
          const randomImage =
            results[Math.floor(Math.random() * results.length)].urls.regular;

          // إرسال الصورة عبر واتساب
          await sock.sendMessage(chatId, {
            image: { url: randomImage },
            caption: `📷 صورة لـ: *${query}*`,
          });
        } catch (error) {          console.error("❌ خطأ في جلب الصورة:", error);
          await sock.sendMessage(chatId, {
            text: "❌ حدث خطأ أثناء جلب الصورة. حاول البحث بكلمة أخرى.",
          });
        }
        return;
      }

      if (command.startsWith(".ضيف ")) {
        const numberToAdd = command.replace(".ضيف ", "").trim();
        if (!numberToAdd) {
          await sock.sendMessage(chatId, {
            text: "⚠️ استخدم: .ضيف [رقم الهاتف]",});
          return;
        }

        const fullNumber = numberToAdd + "@s.whatsapp.net";
        const ownerNumber = "201500302461@s.whatsapp.net"; // ضع رقمك هنا بنفس الصيغة!

        try {
          const groupMetadata = await sock.groupMetadata(chatId);
          const participants = groupMetadata.participants;
          const admins = participants.filter((p) => p.admin).map((p) => p.id);
          const botNumber = sock.user.id.split(":")[0] + "@s.whatsapp.net";

          // التحقق مما إذا كان المستخدم إدمنًا أو صاحب البوت
          const isAdmin = admins.includes(senderId);
          const isOwner = senderId === ownerNumber;

          if (!isAdmin && !isOwner) {
            await sock.sendMessage(chatId, {
              text: "⛔ هذا الأمر متاح فقط للمشرفين.",
            });
            return;
          }

          // التحقق مما إذا كان البوت إدمنًا
          if (!admins.includes(botNumber)) {
            await sock.sendMessage(chatId, {
              text: "❌ يجب أن يكون البوت مشرفًا في المجموعة لإضافة الأعضاء.",
            });
            return;
          }

          // تنفيذ أمر الإضافة
          const response = await sock.groupParticipantsUpdate(
            chatId,
            [fullNumber],
            "add",
          );

          if (response[fullNumber] && response[fullNumber].status === 200) {
            await sock.sendMessage(chatId, {
              text: `✅ تم إضافة الرقم: ${numberToAdd}`,
            });
          } else {
            throw new Error(
              "❌ لم أتمكن من إضافة الرقم. تأكد أن الرقم صحيح ويملك واتساب.",
            );
          }
        } catch (error) {
          console.error("❌ خطأ في إضافة الرقم:", error);
          await sock.sendMessage(chatId, {
            text: "❌ لم أتمكن من إضافة الرقم. تأكد أن البوت مشرف والرقم صحيح.",
          });
        }
        return;
      }

      if (command.startsWith(".طرد ")) {
        const numberToRemove = command.replace(".طرد ", "").trim();
        if (!numberToRemove) {
          await sock.sendMessage(chatId, {
            text: "⚠️ استخدم: .طرد [رقم الهاتف]",
          });
          return;
        }

        const fullNumber = numberToRemove + "@s.whatsapp.net";
        const ownerNumber = "201500302461@s.whatsapp.net"; // ضع رقمك هنا!

        try {
          const groupMetadata = await sock.groupMetadata(chatId);
          const participants = groupMetadata.participants;
          const admins = participants.filter((p) => p.admin).map((p) => p.id);
          const botNumber = sock.user.id.split(":")[0] + "@s.whatsapp.net";

          // التحقق مما إذا كان المستخدم إدمنًا أو صاحب البوت
          const isAdmin = admins.includes(senderId);
          const isOwner = senderId === ownerNumber;

          if (!isAdmin && !isOwner) {
            await sock.sendMessage(chatId, {
              text: "⛔ هذا الأمر متاح فقط للمشرفين.",
            });
            return;
          }

          // التحقق مما إذا كان البوت إدمنًا
          if (!admins.includes(botNumber)) {
            await sock.sendMessage(chatId, {
              text: "❌ يجب أن يكون البوت مشرفًا لطرد الأعضاء.",
            });
            return;
          }

          // تنفيذ أمر الطرد
          const response = await sock.groupParticipantsUpdate(
            chatId,
            [fullNumber],
            "remove",
          );

          if (response[fullNumber] && response[fullNumber].status === 200) {
            await sock.sendMessage(chatId, {
              text: `✅ تم طرد الرقم: ${numberToRemove}`,
            });
          } else {
            throw new Error(
              "❌ لم أتمكن من طرد الرقم. ربما الرقم غير موجود أو لا يمكن طرده.",
            );
          }
        } catch (error) {
          console.error("❌ خطأ في طرد الرقم:", error);
          await sock.sendMessage(chatId, {
            text: "❌ لم أتمكن من طرد الرقم. تأكد أن البوت مشرف والرقم موجود في الجروب.",
          });
        }
        return;
      }

      if (command === ".رسائلي") {
        const userMessageCount = messageCount[senderId] || 0;
        await sock.sendMessage(chatId, {
          text: `📊 عدد رسائلك: ${userMessageCount}`,
        });
        return;
      }

      if (command === ".المتفاعلين") {
        try {
          // إضافة رياكشن على رسالة المستخدم
          await sock.sendMessage(
            chatId, 
            { react: { key: msg.key, text: "⏳" }}
          );
          
          // التحقق من أن الدردشة هي مجموعة
          if (!chatId.endsWith("@g.us")) {
            await sock.sendMessage(
              chatId, 
              { react: { key: msg.key, text: "❌" }}
            );
            await sock.sendMessage(chatId, {
              text: "⚠️ هذا الأمر يعمل في المجموعات فقط!",
            });
            return;
          }
          
          // التحقق من صلاحيات المستخدم
          const groupMetadata = await sock.groupMetadata(chatId);
          const participants = groupMetadata.participants;
          
          // جلب قائمة المشرفين
          const groupAdmins = participants
            .filter((p) => p.admin === "superadmin" || p.admin === "admin")
            .map((p) => p.id);
            
          const ownerNumber = "201500302461@s.whatsapp.net"; // رقم المالك
          const isAdmin = groupAdmins.includes(senderId);
          const isOwner = senderId === ownerNumber;
          
          // التحقق من أن المستخدم إدمن أو صاحب البوت
          if (!isAdmin && !isOwner) {
            await sock.sendMessage(
              chatId, 
              { react: { key: msg.key, text: "🔒" }}
            );
            await sock.sendMessage(chatId, {
              text: "⛔ هذا الأمر متاح فقط للمشرفين.",
            });
            return;
          }

          // تصفية المتفاعلين ليكونوا فقط من أعضاء الجروب
          const groupParticipants = participants.map((p) => p.id);
          const filteredUsers = Object.keys(messageCount)
            .filter((userId) => groupParticipants.includes(userId)) // فلترة الأعضاء
            .sort((a, b) => messageCount[b] - messageCount[a]) // ترتيب حسب عدد الرسائل
            .slice(0, 5); // جلب أعلى 5

          if (filteredUsers.length === 0) {
            // تغيير الرياكشن إلى علامة خطأ
            await sock.sendMessage(
              chatId, 
              { react: { key: msg.key, text: "❌" }}
            );
            await sock.sendMessage(chatId, {
              text: "❌ لا يوجد بيانات تفاعل حتى الآن.",
            });
            return;
          }

          const topUsers = filteredUsers
            .map(
              (userId) =>
                `@${userId.split("@")[0]}: ${messageCount[userId]} رسالة`,
            )
            .join("\n");

          // تغيير الرياكشن إلى علامة تمام
          await sock.sendMessage(
            chatId, 
            { react: { key: msg.key, text: "✅" }}
          );

          await sock.sendMessage(chatId, {
            text: `
┏━━━━❮ 📊 *أكثر المتفاعلين* 📊 ❯━━━━┓
${topUsers}
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛`,
            mentions: filteredUsers,
          });
        } catch (error) {
          console.error("❌ خطأ في جلب المتفاعلين:", error);
          // تغيير الرياكشن إلى علامة خطأ
          await sock.sendMessage(
            chatId, 
            { react: { key: msg.key, text: "❌" }}
          );
          await sock.sendMessage(chatId, {
            text: "❌ حدث خطأ أثناء جلب المتفاعلين.",
          });
        }
        return;
      }

      if (command === ".منشن") {
        try {
          // إضافة رياكشن انتظار على رسالة المستخدم
          await sock.sendMessage(
            chatId, 
            { react: { key: msg.key, text: "⏳" }}
          );
          
          // التحقق من أن الدردشة هي مجموعة
          if (!chatId.endsWith("@g.us")) {
            await sock.sendMessage(
              chatId, 
              { react: { key: msg.key, text: "❌" }}
            );
            await sock.sendMessage(chatId, {
              text: "⚠️ هذا الأمر يعمل في المجموعات فقط!",
            });
            return;
          }

          const ownerNumber = "201500302461@s.whatsapp.net"; // رقم المالك

          // جلب بيانات الجروب
          const groupMetadata = await sock.groupMetadata(chatId);
          const participants = groupMetadata.participants;

          // استخراج الإدمنز
          const admins = participants.filter((p) => p.admin).map((p) => p.id);

          // التحقق إذا كان المستخدم أدمنًا أو أنه أنت
          const isAdmin = admins.includes(senderId);
          const isOwner = senderId === ownerNumber;

          if (!isAdmin && !isOwner) {
            // تغيير الرياكشن إلى علامة قفل
            await sock.sendMessage(
              chatId, 
              { react: { key: msg.key, text: "🔒" }}
            );
            
            await sock.sendMessage(chatId, {
              text: "⛔ هذا الأمر متاح للمشرفين فقط!",
            });
            return;
          }

          // تحويل جميع الأعضاء إلى صيغة المنشن
          const mentions = participants
            .map((p) => `@${p.id.split("@")[0]}`)
            .join("\n");

          // تغيير الرياكشن إلى علامة تمام
          await sock.sendMessage(
            chatId, 
            { react: { key: msg.key, text: "✅" }}
          );

          await sock.sendMessage(chatId, {
            text: `
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃       📢 *منشن جماعي* 📢      ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

${mentions}`,
            mentions: participants.map((p) => p.id),
          });
        } catch (error) {
          console.error("❌ خطأ أثناء تنفيذ المنشن الجماعي:", error);
          // تغيير الرياكشن إلى علامة خطأ
          await sock.sendMessage(
            chatId, 
            { react: { key: msg.key, text: "❌" }}
          );
          
          await sock.sendMessage(chatId, {
            text: "❌ حدث خطأ أثناء تنفيذ الأمر.",
          });
        }
        return;
      }

      // قائمة المحافظات
      const cities = [
        { name: "القاهرة", id: "Cairo" },
        { name: "الجيزة", id: "Giza" },
        { name: "الإسكندرية", id: "Alexandria" },
        { name: "أسيوط", id: "Asyut" },
        { name: "سوهاج", id: "Sohag" },
      ];

      // نظام الأسئلة والإجابات
      const activeQuizzes = {};

      if (command === ".سؤال") {
        try {
          // التحقق إذا كان هناك اختبار نشط بالفعل في هذه المجموعة
          if (activeQuizzes[chatId]) {
            await sock.sendMessage(chatId, {
              text: "⚠️ هناك سؤال نشط بالفعل في هذه المجموعة. انتظر حتى تنتهي أو استخدم .الغاء_سؤال لإلغائه.",
            });
            return;
          }

          // قائمة بالأسئلة والإجابات
          const quizQuestions = [
            {
              question: "ما هي عاصمة مصر؟",
              options: ["القاهرة", "الإسكندرية", "الجيزة", "أسوان"],
              correctAnswer: 0 // القاهرة
            },
            {
              question: "ما هي أطول نهر في العالم؟",
              options: ["الأمازون", "النيل", "المسيسيبي", "اليانغتسي"],
              correctAnswer: 1 // النيل
            },
            {
              question: "كم عدد أضلاع المسدس؟",
              options: ["4", "5", "6", "7"],
              correctAnswer: 2 // 6
            },
            {
              question: "ما هو العنصر الكيميائي الذي رمزه O؟",
              options: ["الذهب", "الفضة", "الأكسجين", "الأوزون"],
              correctAnswer: 2 // الأكسجين
            },
            {
              question: "من مؤلف كتاب مقدمة ابن خلدون؟",
              options: ["الفارابي", "ابن سينا", "ابن رشد", "ابن خلدون"],
              correctAnswer: 3 // ابن خلدون
            }
          ];

          // اختيار سؤال عشوائي
          const randomQuestion = quizQuestions[Math.floor(Math.random() * quizQuestions.length)];

          // إنشاء الخيارات مع الترقيم
          const formattedOptions = randomQuestion.options.map((option, index) => 
            `${index + 1}. ${option}`
          ).join("\n");

          // حفظ معلومات السؤال النشط
          activeQuizzes[chatId] = {
            ...randomQuestion,
            participants: {},
            startTime: Date.now(),
            timeout: setTimeout(() => {
              // إنهاء السؤال بعد دقيقة واحدة
              if (activeQuizzes[chatId]) {
                sock.sendMessage(chatId, {
                  text: `⏱️ انتهى الوقت! الإجابة الصحيحة هي: *${randomQuestion.options[randomQuestion.correctAnswer]}*`,
                });
                delete activeQuizzes[chatId];
              }
            }, 60000)
          };

          // إرسال السؤال
          await sock.sendMessage(chatId, {
            text: `
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃         🧠 *سؤال ثقافي* 🧠         ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

❓ *السؤال:* ${randomQuestion.question}

${formattedOptions}

⏱️ *لديك دقيقة واحدة للإجابة*
📝 *للإجابة اكتب رقم الإجابة وقم بعمل منشن للبوت*
مثال: @بوت 2
`,
          });
        } catch (error) {
          console.error("❌ خطأ في إرسال السؤال:", error);
          await sock.sendMessage(chatId, {
            text: "❌ حدث خطأ أثناء إنشاء السؤال. حاول مرة أخرى.",
          });
        }
        return;
      }

      if (command === ".الغاء_سؤال") {
        // التحقق من وجود اختبار نشط
        if (!activeQuizzes[chatId]) {
          await sock.sendMessage(chatId, {
            text: "❌ لا يوجد سؤال نشط حاليًا.",
          });
          return;
        }

        // إلغاء المؤقت
        clearTimeout(activeQuizzes[chatId].timeout);

        // إرسال الإجابة الصحيحة
        await sock.sendMessage(chatId, {
          text: `🛑 تم إلغاء السؤال. الإجابة الصحيحة هي: *${activeQuizzes[chatId].options[activeQuizzes[chatId].correctAnswer]}*`,
        });

        // حذف السؤال النشط
        delete activeQuizzes[chatId];
        return;
      }

      // التحقق من الإجابات على الأسئلة
      if (text.includes("@" + sock.user.id.split(":")[0]) && /\d+/.test(text)) {
        // التحقق من وجود سؤال نشط
        if (!activeQuizzes[chatId]) {
          return;
        }

        // استخراج رقم الإجابة
        const answer = parseInt(text.match(/\d+/)[0]);

        // التحقق من صحة رقم الإجابة
        if (isNaN(answer) || answer < 1 || answer > activeQuizzes[chatId].options.length) {
          await sock.sendMessage(chatId, {
            text: "⚠️ رقم الإجابة غير صالح. يرجى إدخال رقم بين 1 و " + activeQuizzes[chatId].options.length,
            mentions: [senderId]
          });
          return;
        }

        // تخزين إجابة المشارك
        if (!activeQuizzes[chatId].participants[senderId]) {
          activeQuizzes[chatId].participants[senderId] = answer - 1; // تخزين الإجابة (0-indexed)

          // التحقق من صحة الإجابة
          const isCorrect = (answer - 1) === activeQuizzes[chatId].correctAnswer;

          if (isCorrect) {
            // إنهاء السؤال إذا كانت الإجابة صحيحة
            clearTimeout(activeQuizzes[chatId].timeout);

            await sock.sendMessage(chatId, {
              text: `
🎉 *إجابة صحيحة!* 

👏 *الفائز:* @${senderId.split("@")[0]}
✅ *الإجابة:* ${activeQuizzes[chatId].options[activeQuizzes[chatId].correctAnswer]}

🔄 استخدم *.سؤال* للحصول على سؤال جديد
`,
              mentions: [senderId]
            });

            // حذف السؤال النشط
            delete activeQuizzes[chatId];
          } else {
            // إشعار بالإجابة الخاطئة
            await sock.sendMessage(chatId, {
              text: `❌ إجابة خاطئة يا @${senderId.split("@")[0]}، حاول مرة أخرى!`,
              mentions: [senderId]
            });
          }
        } else {
          // المشارك أجاب بالفعل
          await sock.sendMessage(chatId, {
            text: `⚠️ لقد قمت بالإجابة بالفعل يا @${senderId.split("@")[0]}!`,
            mentions: [senderId]
          });
        }
        return;
      }

      // أمر ثقافة - معلومات عن الدول
      if (command === ".ثقافة" || command === ".ثقافه") {
        const categories = [
          { name: "🌍 الدول العربية", id: "arab" },
          { name: "🌍 الدول الأوروبية", id: "europe" },
          { name: "🌎 الدول الأمريكية", id: "america" },
          { name: "🌏 الدول الآسيوية", id: "asia" },
          { name: "🌍 الدول الأفريقية", id: "africa" }
        ];

        let categoryList = `
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃         🌐 *فئات الدول* 🌐          ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n`;

        categories.forEach((category, index) => {
          categoryList += `*${index + 1}.* ${category.name}\n`;
        });

        categoryList += "\n🔹 *اختر رقم الفئة لعرض الدول.*";

        await sock.sendMessage(chatId, { text: categoryList });
        setUserState(senderId, chatId, "category"); // تعيين حالة المستخدم لاختيار الفئة
        return;
      }

      // معالجة اختيار الفئة
      const userStatus = getUserState(senderId, chatId);
      
      if (msg.message?.extendedTextMessage?.contextInfo?.quotedMessage && /^[1-5]$/.test(text)) {
        const quotedMessage = msg.message.extendedTextMessage.contextInfo.quotedMessage;
        if (quotedMessage?.conversation?.includes("فئات الدول") || quotedMessage?.extendedTextMessage?.text?.includes("فئات الدول")) {
          const categoryIndex = parseInt(text) - 1;
        const categories = {
          arab: [
            { name: "مصر", emoji: "🇪🇬" },
            { name: "السعودية", emoji: "🇸🇦" },
            { name: "الإمارات", emoji: "🇦🇪" },
            { name: "المغرب", emoji: "🇲🇦" },
            { name: "تونس", emoji: "🇹🇳" },
            { name: "الجزائر", emoji: "🇩🇿" },
            { name: "العراق", emoji: "🇮🇶" },
            { name: "الأردن", emoji: "🇯🇴" },
            { name: "لبنان", emoji: "🇱🇧" },
            { name: "ليبيا", emoji: "🇱🇾" }
          ],
          europe: [
            { name: "بريطانيا", emoji: "🇬🇧" },
            { name: "فرنسا", emoji: "🇫🇷" },
            { name: "ألمانيا", emoji: "🇩🇪" },
            { name: "إيطاليا", emoji: "🇮🇹" },
            { name: "إسبانيا", emoji: "🇪🇸" },
            { name: "هولندا", emoji: "🇳🇱" },
            { name: "بلجيكا", emoji: "🇧🇪" },
            { name: "السويد", emoji: "🇸🇪" },
            { name: "النرويج", emoji: "🇳🇴" },
            { name: "سويسرا", emoji: "🇨🇭" }
          ],
          america: [
            { name: "الولايات المتحدة", emoji: "🇺🇸" },
            { name: "كندا", emoji: "🇨🇦" },
            { name: "البرازيل", emoji: "🇧🇷" },
            { name: "الأرجنتين", emoji: "🇦🇷" },
            { name: "المكسيك", emoji: "🇲🇽" },
            { name: "تشيلي", emoji: "🇨🇱" },
            { name: "كولومبيا", emoji: "🇨🇴" },
            { name: "بيرو", emoji: "🇵🇪" },
            { name: "فنزويلا", emoji: "🇻🇪" },
            { name: "أوروغواي", emoji: "🇺🇾" }
          ],
          asia: [
            { name: "الصين", emoji: "🇨🇳" },
            { name: "اليابان", emoji: "🇯🇵" },
            { name: "كوريا الجنوبية", emoji: "🇰🇷" },
            { name: "الهند", emoji: "🇮🇳" },
            { name: "إندونيسيا", emoji: "🇮🇩" },
            { name: "ماليزيا", emoji: "🇲🇾" },
            { name: "سنغافورة", emoji: "🇸🇬" },
            { name: "تايلاند", emoji: "🇹🇭" },
            { name: "فيتنام", emoji: "🇻🇳" },
            { name: "الفلبين", emoji: "🇵🇭" }
          ],
          africa: [
            { name: "جنوب أفريقيا", emoji: "🇿🇦" },
            { name: "نيجيريا", emoji: "🇳🇬" },
            { name: "كينيا", emoji: "🇰🇪" },
            { name: "إثيوبيا", emoji: "🇪🇹" },
            { name: "غانا", emoji: "🇬🇭" },
            { name: "السنغال", emoji: "🇸🇳" },
            { name: "تنزانيا", emoji: "🇹🇿" },
            { name: "أوغندا", emoji: "🇺🇬" },
            { name: "زامبيا", emoji: "🇿🇲" },
            { name: "الكاميرون", emoji: "🇨🇲" }
          ]
        };

        const categoryIds = ["arab", "europe", "america", "asia", "africa"];
        const selectedCategory = categories[categoryIds[categoryIndex]];

        let countryList = `
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃         📍 *قائمة الدول* 📍         ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n`;

        selectedCategory.forEach((country, index) => {
          countryList += `*${index + 1}.* ${country.emoji} ${country.name}\n`;
        });

        countryList += "\n🔹 *اكتب رقم الدولة لمعرفة معلوماتها.*";

        await sock.sendMessage(chatId, { text: countryList });
        setUserState(senderId, chatId, "culture"); // تعيين حالة المستخدم لاختيار الدولة
        return;
      }

      // معالجة اختيار الدولة
      if (/^[1-9]|1[0-5]$/.test(command)) {
        const userStatus = getUserState(senderId, chatId);
        const inputNumber = parseInt(command);

        // تنفيذ أمر الثقافة (عرض معلومات الدول)
        if (userStatus === "culture" && inputNumber >= 1 && inputNumber <= 15) {
          const countryIndex = inputNumber - 1;

          // قائمة الدول ومعلوماتها
          const countries = [
            { 
              name: "مصر", 
              emoji: "🇪🇬",
              info: `
*🇪🇬 جمهورية مصر العربية*

🏛️ *العاصمة:* القاهرة
👥 *عدد السكان:* حوالي 104 مليون نسمة
🗣️ *اللغة الرسمية:* العربية
💰 *العملة:* الجنيه المصري

🏺 *نبذة تاريخية:*
مصر هي مهد الحضارة الفرعونية القديمة التي تأسست حوالي 3100 قبل الميلاد. تضم أهرامات الجيزة وأبو الهول، من عجائب الدنيا السبع القديمة.

🌊 *معالم سياحية:*
• الأهرامات وأبو الهول
• المتحف المصري
• نهر النيل
• الأقصر والكرنك
• سيناء وشرم الشيخ

🍽️ *أشهر الأطعمة:*
• الكشري
• الملوخية
• الفول المدمس
• الكباب والكفتة
`
            },
            { 
              name: "السعودية", 
              emoji: "🇸🇦",
              info: `
*🇸🇦 المملكة العربية السعودية*

🏛️ *العاصمة:* الرياض
👥 *عدد السكان:* حوالي 35 مليون نسمة
🗣️ *اللغة الرسمية:* العربية
💰 *العملة:* الريال السعودي

🕋 *نبذة تاريخية:*
تأسست المملكة العربية السعودية الحديثة على يد الملك عبد العزيز آل سعود عام 1932م. تضم مكة المكرمة والمدينة المنورة، أقدس المدن الإسلامية.

🏙️ *معالم سياحية:*
• المسجد الحرام في مكة
• المسجد النبوي في المدينة
• الدرعية التاريخية
• العلا ومدائن صالح
• كورنيش جدة

🍽️ *أشهر الأطعمة:*
• الكبسة
• المندي
• المطازيز
• الجريش
`
            },
            { 
              name: "الإمارات", 
              emoji: "🇦🇪",
              info: `
*🇦🇪 دولة الإمارات العربية المتحدة*

🏛️ *العاصمة:* أبوظبي
👥 *عدد السكان:* حوالي 10 مليون نسمة
🗣️ *اللغة الرسمية:* العربية
💰 *العملة:* درهم إماراتي

🏜️ *نبذة تاريخية:*
تأسست دولة الإمارات العربية المتحدة في 2 ديسمبر 1971م كاتحاد لسبع إمارات. شهدت تطوراً هائلاً خلال العقود الأخيرة لتصبح مركزاً اقتصادياً عالمياً.

🏙️ *معالم سياحية:*
• برج خليفة (أطول برج في العالم)
• متحف اللوفر أبوظبي
• جزيرة ياس
• دبي مول
• جزيرة النخلة

🍽️ *أشهر الأطعمة:*
• المجبوس
• الهريس
• اللقيمات
• البرياني الإماراتي
`
            },
            { 
              name: "المغرب", 
              emoji: "🇲🇦",
              info: `
*🇲🇦 المملكة المغربية*

🏛️ *العاصمة:* الرباط
👥 *عدد السكان:* حوالي 37 مليون نسمة
🗣️ *اللغات الرسمية:* العربية والأمازيغية
💰 *العملة:* الدرهم المغربي

🏯 *نبذة تاريخية:*
المغرب من أقدم الدول في شمال أفريقيا، مع تاريخ غني من الحضارات المتعاقبة من الفينيقيين إلى الرومان والعرب والأمازيغ.

🏞️ *معالم سياحية:*
• مدينة مراكش القديمة
• مدينة فاس العتيقة
• الصحراء الكبرى
• جبال الأطلس
• شفشاون المدينة الزرقاء

🍽️ *أشهر الأطعمة:*
• الطاجين
• الكسكس
• البسطيلة
• الحريرة
`
            },
            { 
              name: "تونس", 
              emoji: "🇹🇳",
              info: `
*🇹🇳 الجمهورية التونسية*

🏛️ *العاصمة:* تونس
👥 *عدد السكان:* حوالي 12 مليون نسمة
🗣️ *اللغة الرسمية:* العربية
💰 *العملة:* الدينار التونسي

🏛️ *نبذة تاريخية:*
تونس لها تاريخ عريق يمتد لآلاف السنين، حيث كانت موطناً للحضارة القرطاجية وجزءاً من الإمبراطورية الرومانية قبل الفتح الإسلامي.

🏖️ *معالم سياحية:*
• موقع قرطاج الأثري
• مدينة سيدي بوسعيد
• جزيرة جربة
• المدينة العتيقة في تونس
• الصحراء التونسية

🍽️ *أشهر الأطعمة:*
• الكسكسي
• البريك
• الطاجين التونسي
• المقرونة بالملوخية
`
            },
            { 
              name: "الجزائر", 
              emoji: "🇩🇿",
              info: `
*🇩🇿 الجمهورية الجزائرية الديمقراطية الشعبية*

🏛️ *العاصمة:* الجزائر
👥 *عدد السكان:* حوالي 44 مليون نسمة
🗣️ *اللغات الرسمية:* العربية والأمازيغية
💰 *العملة:* الدينار الجزائري

🏜️ *نبذة تاريخية:*
الجزائر من أكبر دول أفريقيا، لها تاريخ غني بالحضارات المختلفة. نالت استقلالها من فرنسا عام 1962 بعد ثورة تحرير دامت ثماني سنوات.

🏞️ *معالم سياحية:*
• قصبة الجزائر (موقع تراث عالمي)
• تيمقاد الرومانية
• الهقار والطاسيلي
• شواطئ عنابة وجيجل
• الواحات الصحراوية

🍽️ *أشهر الأطعمة:*
• الشخشوخة
• الكسكس الجزائري
• الطاجين
• المحاجب
`
            },
            { 
              name: "العراق", 
              emoji: "🇮🇶",
              info: `
*🇮🇶 جمهورية العراق*

🏛️ *العاصمة:* بغداد
👥 *عدد السكان:* حوالي 41 مليون نسمة
🗣️ *اللغات الرسمية:* العربية والكردية
💰 *العملة:* الدينار العراقي

🏺 *نبذة تاريخية:*
العراق هو مهد حضارة بلاد ما بين النهرين (سومر وبابل وآشور)، ويعتبر أحد أقدم مراكز الحضارة في العالم.

🏯 *معالم سياحية:*
• المدائن (طاق كسرى)
• موقع بابل الأثري
• الأهوار العراقية
• زقورة أور
• المتحف العراقي

🍽️ *أشهر الأطعمة:*
• المسكوف
• الدولمة
• الكبة العراقية
• القيمة
`
            },
            { 
              name: "الأردن", 
              emoji: "🇯🇴",
              info: `
*🇯🇴 المملكة الأردنية الهاشمية*

🏛️ *العاصمة:* عمّان
👥 *عدد السكان:* حوالي 10 مليون نسمة
🗣️ *اللغة الرسمية:* العربية
💰 *العملة:* الدينار الأردني

🏛️ *نبذة تاريخية:*
الأردن أرض تاريخية تضم آثاراً من الحضارات النبطية والرومانية والبيزنطية والإسلامية. تأسست المملكة الحديثة عام 1946.

🏞️ *معالم سياحية:*
• مدينة البتراء الوردية
• وادي رم
• جرش الرومانية
• البحر الميت
• قلعة عجلون

🍽️ *أشهر الأطعمة:*
• المنسف
• المقلوبة
• الكنافة النابلسية
• المحاشي
`
            },
            { 
              name: "لبنان", 
              emoji: "🇱🇧",
              info: `
*🇱🇧 الجمهورية اللبنانية*

🏛️ *العاصمة:* بيروت
👥 *عدد السكان:* حوالي 6.8 مليون نسمة
🗣️ *اللغة الرسمية:* العربية
💰 *العملة:* الليرة اللبنانية

🌲 *نبذة تاريخية:*
لبنان موطن الحضارة الفينيقية القديمة وملتقى الحضارات والثقافات عبر التاريخ. اشتهر قديماً بأرز لبنان الذي يزين علمه.

🏞️ *معالم سياحية:*
• قلعة بعلبك
• مغارة جعيتا
• أرز الرب
• بيبلوس القديمة
• شواطئ جونية

🍽️ *أشهر الأطعمة:*
• التبولة
• الحمص
• الفتوش
• الكبة النية
• المنقوشة
`
            },
            { 
              name: "ليبيا", 
              emoji: "🇱🇾",
              info: `
*🇱🇾 دولة ليبيا*

🏛️ *العاصمة:* طرابلس
👥 *عدد السكان:* حوالي 7 مليون نسمة
🗣️ *اللغة الرسمية:* العربية
💰 *العملة:* الدينار الليبي

🏜️ *نبذة تاريخية:*
ليبيا أرض تعاقبت عليها حضارات عدة كالفينيقيين والإغريق والرومان والعرب والعثمانيين. تمتلك أكبر احتياطي نفطي في أفريقيا.

🏛️ *معالم سياحية:*
• لبدة الكبرى
• شحات (قورينا)
• جبال أكاكوس
• قلعة السرايا الحمراء
• الصحراء الليبية

🍽️ *أشهر الأطعمة:*
• البازين
• المبخرة
• الشوربة الليبية
• المقروض
`
            },
            { 
              name: "الولايات المتحدة", 
              emoji: "🇺🇸",
              info: `
*🇺🇸 الولايات المتحدة الأمريكية*

🏛️ *العاصمة:* واشنطن العاصمة
👥 *عدد السكان:* حوالي 331 مليون نسمة
🗣️ *اللغة الرسمية:* الإنجليزية (على مستوى الولايات تختلف)
💰 *العملة:* الدولار الأمريكي

🏛️ *نبذة تاريخية:*
تأسست الولايات المتحدة في عام 1776 بعد إعلان الاستقلال عن بريطانيا. وهي تتكون من 50 ولاية وتعتبر من أكبر القوى الاقتصادية والعسكرية في العالم.

🏙️ *معالم سياحية:*
• تمثال الحرية في نيويورك
• البيت الأبيض في واشنطن
• جسر البوابة الذهبية في سان فرانسيسكو
• حديقة يلوستون الوطنية
• شلالات نياجرا

🍽️ *أشهر الأطعمة:*
• الهامبرغر
• البيتزا الأمريكية
• الهوت دوج
• الكعك بالقيقب
`
            },
            { 
              name: "الصين", 
              emoji: "🇨🇳",
              info: `
*🇨🇳 جمهورية الصين الشعبية*

🏛️ *العاصمة:* بكين
👥 *عدد السكان:* حوالي 1.4 مليار نسمة
🗣️ *اللغة الرسمية:* الصينية الماندرين
💰 *العملة:* اليوان الصيني (رنمينبي)

🏯 *نبذة تاريخية:*
الصين من أقدم الحضارات في العالم مع تاريخ يمتد لأكثر من 5000 عام. أسست جمهورية الصين الشعبية عام 1949، وأصبحت ثاني أكبر اقتصاد في العالم.

🏞️ *معالم سياحية:*
• سور الصين العظيم
• المدينة المحرمة في بكين
• جيش التيراكوتا في شيان
• شنغهاي بمبانيها الشاهقة
• الأراضي الغامضة في التبت

🍽️ *أشهر الأطعمة:*
• البط المحمر
• الدمبلنج (الجياوزي)
• الأرز المقلي
• الماهوتونج (القدر الساخن)
`
            },
            { 
              name: "بريطانيا", 
              emoji: "🇬🇧",
              info: `
*🇬🇧 المملكة المتحدة لبريطانيا العظمى وأيرلندا الشمالية*

🏛️ *العاصمة:* لندن
👥 *عدد السكان:* حوالي 68 مليون نسمة
🗣️ *اللغة الرسمية:* الإنجليزية
💰 *العملة:* الجنيه الإسترليني

⚔️ *نبذة تاريخية:*
بريطانيا لها تاريخ غني من الملوك والملكات. كانت إمبراطورية عالمية في القرن 19 و20، وهي اليوم من الدول المتقدمة وعضو دائم في مجلس الأمن.

🏰 *معالم سياحية:*
• قصر باكنغهام
• ساعة بيج بن
• برج لندن
• ستونهنج
• جامعتي أكسفورد وكامبريدج

🍽️ *أشهر الأطعمة:*
• الفيش آند تشيبس
• الفطور الإنجليزي الكامل
• فطيرة الراعي
• البودينغ اليوركشاير
`
            },
            { 
              name: "فرنسا", 
              emoji: "🇫🇷",
              info: `
*🇫🇷 الجمهورية الفرنسية*

🏛️ *العاصمة:* باريس
👥 *عدد السكان:* حوالي 67 مليون نسمة
🗣️ *اللغة الرسمية:* الفرنسية
💰 *العملة:* اليورو

🏰 *نبذة تاريخية:*
فرنسا من أكبر الدول الأوروبية وذات تاريخ غني بالثورات والفنون. شهدت الثورة الفرنسية عام 1789 التي غيرت وجه أوروبا والعالم.

🏙️ *معالم سياحية:*
• برج إيفل
• متحف اللوفر
• قصر فرساي
• كاتدرائية نوتردام
• الريفييرا الفرنسية

🍽️ *أشهر الأطعمة:*
• الكرواسون
• الفوا جرا
• الرتاتوي
• البوياباسي
• السوفليه
`
            },
            { 
              name: "ألمانيا", 
              emoji: "🇩🇪",
              info: `
*🇩🇪 جمهورية ألمانيا الاتحادية*

🏛️ *العاصمة:* برلين
👥 *عدد السكان:* حوالي 83 مليون نسمة
🗣️ *اللغة الرسمية:* الألمانية
💰 *العملة:* اليورو

🏰 *نبذة تاريخية:*
ألمانيا بلد ذو تاريخ حافل، من إمبراطورية قوية إلى الانقسام بعد الحرب العالمية الثانية ثم إعادة التوحيد في 1990. اليوم هي قوة اقتصادية رائدة في أوروبا.

🏙️ *معالم سياحية:*
• بوابة براندنبورغ
• سور برلين
• قلعة نويشفانشتاين
• كاتدرائية كولونيا
• الغابة السوداء

🍽️ *أشهر الأطعمة:*
• النقانق الألمانية (فورست)
• البريتزل
• شنيتزل
• الزاوركراوت
• الكعك الأسود
`
            }
          ];

          // إرسال معلومات الدولة المختارة
          await sock.sendMessage(chatId, { text: countries[countryIndex].info });
          resetUserState(senderId, chatId); // إعادة تعيين حالة المستخدم
          return;
        }

        // تنفيذ أمر الصلاة (عرض مواقيت الصلاة)
        else if (userStatus === "prayer" && inputNumber >= 1 && inputNumber <= cities.length) {
          const city = cities[inputNumber - 1].id;

          try {
            // إرسال رسالة انتظار
            await sock.sendMessage(chatId, {
              text: "⏳ جاري جلب مواقيت الصلاة... انتظر قليلاً",
            });

            // استخدام axios مباشرة بدلاً من استيراد node-fetch
            const prayerResponse = await axios.get(
              `https://api.aladhan.com/v1/timingsByCity?city=${city}&country=Egypt&method=5`,
              { timeout: 10000 } // زيادة مهلة الانتظار
            );

            if (!prayerResponse.data || !prayerResponse.data.data || !prayerResponse.data.data.timings) {
              throw new Error("بيانات غير صالحة من API");
            }

            const timings = prayerResponse.data.data.timings;

            // تحويل التوقيت إلى 12 ساعة
            const format12Hour = (time) => {
              let [hour, minute] = time.split(":").map(Number);
              let period = hour >= 12 ? "م" : "ص";
              hour = hour % 12 || 12; // تحويل 0 إلى 12 صباحًا
              return `${hour}:${minute.toString().padStart(2, '0')} ${period}`;
            };

            const prayerTimes = `
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃    🕌 *مواقيت الصلاة* 🕌    ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

📍 *المدينة:* ${cities[inputNumber - 1].name}
📅 *التاريخ:* ${new Date().toLocaleDateString("ar-EG")}

⏰ *الفجر:* ${format12Hour(timings.Fajr)}
🌅 *الشروق:* ${format12Hour(timings.Sunrise)}
☀️ *الظهر:* ${format12Hour(timings.Dhuhr)}
🌇 *العصر:* ${format12Hour(timings.Asr)}
🌆 *المغرب:* ${format12Hour(timings.Maghrib)}
🌙 *العشاء:* ${format12Hour(timings.Isha)}
`;

            await sock.sendMessage(chatId, { text: prayerTimes });
            resetUserState(senderId, chatId); // إعادة تعيين حالة المستخدم
          } catch (error) {
            console.error("❌ خطأ في جلب مواقيت الصلاة:", error);
            await sock.sendMessage(chatId, {
              text: "⚠️ حدث خطأ أثناء جلب مواقيت الصلاة. تأكد من اتصالك بالإنترنت وحاول مرة أخرى.",
            });
            resetUserState(Id, chatId); // إعادة تعيين حالة المستخدم حتى في حالة الفشل
          }
          return;
        }
        // إذا لم تكن الحالة "culture" أو "prayer" أو الرقم غير صحيح
        else {
          await sock.sendMessage(chatId, {
            text: "⚠️ الرقم الذي أدخلته غير صحيح أو غير مرتبط بأي أمر حالي. يرجى التأكد من استخدام الأوامر الصحيحة."
          });
          return;
        }
      }

      if (command === ".الصلاة") {
        let menu = "📍 *اختر محافظة لمعرفة مواقيت الصلاة:*\n\n";
        cities.forEach((city, index) => {
          menu += `*${index + 1}.* ${city.name}\n`;
        });
        menu += "\n🔹 *اكتب الرقملاختيار المحافظة.*";

        await sock.sendMessage(chatId, { text: menu });
        setUserState(senderId, chatId, "prayer"); // تعيين حالة المستخدم
        return;
      }

      if (command.startsWith(".كرر ")) {
        const args = text.split(" ");
        const repeatCount = parseInt(args[1]);
        const messageToRepeat = args.slice(2).join(" ");

        if (!isNaN(repeatCount) && repeatCount > 0) {
          for (let i = 0; i < Math.min(repeatCount, 10); i++) { // الحد الأقصى 10 رسائل
            await sock.sendMessage(chatId, { text: messageToRepeat });
          }
        } else {
          await sock.sendMessage(chatId, {
            text: "⚠️ استخدم الأمر بهذا الشكل: .كرر [عدد] [نص]",
          });
        }
        return;
      }

      if (command.startsWith(".كرر_سطر ")) {
        const args = text.split(" ");
        const repeatCount = parseInt(args[1]);
        const messageToRepeat = args.slice(2).join(" ");

        if (!isNaN(repeatCount) && repeatCount > 0) {
          const repeatedText = Array(Math.min(repeatCount, 100)) // الحد الأقصى 100 سطر
            .fill(messageToRepeat)
            .join("\n");
          await sock.sendMessage(chatId, { text: repeatedText });
        } else {
          await sock.sendMessage(chatId, {
            text: "⚠️ استخدم الأمر بهذا الشكل: .كرر_سطر [عدد] [نص]",
          });
        }
        return;
      }

      // إضافة لعبة XO
      if (command === ".xo") {
        // التحقق إذا كان هناك لعبة جارية بالفعل
        if (games[chatId]) {
          await sock.sendMessage(chatId, {
            text: "⚠️ هناك لعبة جارية بالفعل! أكملها أولًا أو استخدم .الغاء لإلغاء اللعبة الحالية.",
          });
          return;
        }

        // إرسال رسالة لبدء اللعبة
        await sock.sendMessage(chatId, {
          text: `
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃    🎮 *لعبة إكس-أو* 🎮    ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

👥 *للعب مع شخص محدد، استخدم:*
.xo @[اسم_الشخص]

🔄 *للعب بشكل عام بدون تحديد:*
.xo عام

📝 *ملاحظة:* عند تحديد الشخص، سيتمكن فقط أنت وذلك الشخص من اللعب
`,
        });
        return;
      }

      // إضافة أمر بدء اللعبة مع شخص محدد
      if (command.startsWith(".xo @") || command === ".xo عام") {
        if (games[chatId]) {
          await sock.sendMessage(chatId, {
            text: "⚠️ هناك لعبة جارية بالفعل! أكملها أولًا أو استخدم .الغاء لإلغاء اللعبة الحالية.",
          });
          return;
        }

        let player1 = senderId;  // دائمًا اللاعب الذي بدأ اللعبة
        let player2 = null;      // سيتم تحديده
        let isOpen = false;      // هل اللعبة مفتوحة للجميع أم لا

        // تحديد إذا كانت اللعبة مفتوحة أو مع شخص محدد
        if (command === ".xo عام") {
          isOpen = true;
        } else {
          // استخراج معرف المستخدم الثاني من الأمر
          try {
            const mentionedUser = msg.message.extendedTextMessage?.contextInfo?.mentionedJid[0];
            if (mentionedUser) {
              player2 = mentionedUser;
            } else {
              // إذا لم يتم تحديد المستخدم بشكل صحيح
              await sock.sendMessage(chatId, {
                text: "⚠️ يرجى التأكد من الإشارة إلى المستخدم بشكل صحيح باستخدام @.",
              });
              return;
            }
          } catch (error) {
            await sock.sendMessage(chatId, {
              text: "⚠️ لم يتم تحديد مستخدم صالح. حاول مرة أخرى بالشكل: .xo @[اسم_الشخص]",
            });
            return;
          }
        }

        // إنشاء لعبة جديدة مع تحديد اللاعبين
        games[chatId] = {
          board: ["0", "1", "2", "3", "4", "5", "6", "7", "8"],
          currentPlayer: "X",
          gameEnded: false,
          player1: player1,        // اللاعب الأول (X)
          player2: player2,        // اللاعب الثاني (O)
          isOpen: isOpen,          // هل اللعبة مفتوحة للجميع
          currentTurn: player1,    // دور من الآن
        };

        // إنشاء النص المناسب حسب نوع اللعبة
        let gameInfoText = "";
        if (isOpen) {
          gameInfoText = `
🔓 *اللعبة مفتوحة للجميع*

🔹 اللاعب الأول (❌): @${player1.split("@")[0]}
🔸 اللاعب الثاني (⭕): أي شخص`;
        } else {
          gameInfoText = `
🔒 *اللعبة محددة للاعبين فقط*

🔹 اللاعب الأول (❌): @${player1.split("@")[0]}
🔸 اللاعب الثاني (⭕): @${player2.split("@")[0]}`;
        }

        // إرسال حالة اللعبة
        await sock.sendMessage(chatId, {
          text: `
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃    🎮 *لعبة إكس-أو* 🎮    ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

${gameInfoText}

اللعبة بدأت! استخدم *.xo [رقم]* للعب

${printBoard(games[chatId].board)}

💡 *مثال:* .xo 4 للعب في المربع رقم 4

🎯 *الدور الحالي:* ❌ @${player1.split("@")[0]}
`,
          mentions: isOpen ? [player1] : [player1, player2],
        });

        return;
      }

      if (command === ".الغاء") {
        if (games[chatId]) {
          // التحقق من أن الشخص الذي يريد إلغاء اللعبة هو أحد اللاعبين
          if (games[chatId].player1 === senderId || 
              games[chatId].player2 === senderId ||
              senderId.endsWith("@g.us")) {
            delete games[chatId];
            await sock.sendMessage(chatId, { text: "✅ تم إلغاء اللعبة الحالية." });
          } else {
            await sock.sendMessage(chatId, {
              text: "⚠️ فقط اللاعبين المشاركين في اللعبة يمكنهم إلغاءها.",
            });
          }
        } else {
          await sock.sendMessage(chatId, {
            text: "❌ لا يوجد لعبة جارية لإلغائها.",
          });
        }
        return;
      }

      if (command.startsWith(".xo ")) {
        if (!games[chatId]) {
          await sock.sendMessage(chatId, {
            text: "❌ لا يوجد لعبة جارية، ابدأ واحدة بـ .xo",
          });
          return;
        }

        // التحقق من أن الشخص الذي يريد اللعب مسموح له (حسب إعدادات اللعبة)
        const game = games[chatId];
        if (!game.isOpen) { // إذا كانت اللعبة محددة للاعبين فقط
          if (game.currentTurn !== senderId && 
              !(game.currentTurn === game.player1 && senderId === game.player2) && 
              !(game.currentTurn === game.player2 && senderId === game.player1)) {
            await sock.sendMessage(chatId, {
              text: `⚠️ ليس دورك للعب! الدور الحالي لـ @${game.currentTurn.split("@")[0]}`,
              mentions: [game.currentTurn],
            });
            return;
          }
        } else { // إذا كانت اللعبة مفتوحة للجميع
          // اللاعب الثاني غير محدد ويمكن لأي شخص أن يلعب
          if (game.currentPlayer === "O" && !game.player2 && senderId !== game.player1) {
            // تسجيل هذا الشخص كلاعب ثاني
            game.player2 = senderId;
          } else if (game.currentTurn !== senderId && senderId !== game.player1 && senderId !== game.player2) {
            await sock.sendMessage(chatId, {
              text: `⚠️ انتظر دورك! الدور الحالي لـ @${game.currentTurn.split("@")[0]}`,
              mentions: [game.currentTurn],
            });
            return;
          }
        }

        const index = parseInt(command.split(" ")[1]);
        if (isNaN(index) || index < 0 || index > 8) {
          await sock.sendMessage(chatId, { text: "⚠️ استخدم رقم بين 0 و 8." });
          return;
        }

        if (
          game.board[index] === "X" ||
          game.board[index] === "O" ||
          game.gameEnded
        ) {
          await sock.sendMessage(chatId, {
            text: "⚠️ هذه الخانة مشغولة أو اللعبة انتهت!",
          });
          return;
        }

        // تحديث اللوحة وتبديل الدور
        game.board[index] = game.currentPlayer;

        // تحديث دور اللاعب التالي
        if (game.currentPlayer === "X") {
          game.currentTurn = game.player2 || "next"; // إذا كان اللاعب الثاني غير محدد بعد
        } else {
          game.currentTurn = game.player1;
        }

        // التحقق من الفائز
        const winner = checkWin(game.board);

        const winnerEmoji = winner === "X" ? "❌" : "⭕";
        const winnerPlayer = winner === "X" ? game.player1 : game.player2;

        if (winner) {
          game.gameEnded = true;
          await sock.sendMessage(chatId, {
            text: `
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃      🎉 *نهاية اللعبة* 🎉      ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

🏆 *الفائز:* ${winnerEmoji} @${winnerPlayer.split("@")[0]}

${printBoard(game.board)}

🔄 *ابدأ لعبة جديدة بكتابة* .xo
`,
            mentions: [winnerPlayer],
          });
          delete games[chatId];
        } else if (
          !game.board.includes("0") &&
          !game.board.includes("1") &&
          !game.board.includes("2") &&
          !game.board.includes("3") &&
          !game.board.includes("4") &&
          !game.board.includes("5") &&
          !game.board.includes("6") &&
          !game.board.includes("7") &&
          !game.board.includes("8")
        ) {
          game.gameEnded = true;
          await sock.sendMessage(chatId, {
            text: `
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃      🎮 *نهاية اللعبة* 🎮      ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

🏳️ *تعادل! لا يوجد فائز*

${printBoard(game.board)}

🔄 *ابدأ لعبة جديدة بكتابة* .xo
`,
          });
          delete games[chatId];
        } else {
          game.currentPlayer = game.currentPlayer === "X" ? "O" : "X";
          const nextPlayerEmoji = game.currentPlayer === "X" ? "❌" : "⭕";
          const nextPlayer = game.currentPlayer === "X" ? game.player1 : (game.player2 || "أي شخص");

          let mentions = [];
          let nextPlayerText = "";

          if (nextPlayer === "أي شخص") {
            nextPlayerText = `${nextPlayerEmoji} أي شخص`;
          } else {
            nextPlayerText = `${nextPlayerEmoji} @${nextPlayer.split("@")[0]}`;
            mentions.push(nextPlayer);
          }

          await sock.sendMessage(chatId, {
            text: `
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃      🎮 *اللعبة مستمرة* 🎮     ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

🎯 *دور اللاعب:* ${nextPlayerText}

${printBoard(game.board)}

💡 استخدم *.xo [رقم]* للعب
`,
            mentions: mentions,
          });
        }
        return;
      }

      if (command === ".اقتباس") {
        try {
          // Dynamically import fetch
          const { default: fetch } = await import("node-fetch");
          const response = await fetch("https://api.quotable.io/random");
          const data = await response.json();
          await sock.sendMessage(chatId, {
            text: `📜 اقتباس: ${data.content}\n\n- *${data.author}*`,
          });
        } catch (error) {
          console.error("❌ خطأ في جلب الاقتباس:", error);
          await sock.sendMessage(chatId, {
            text: "❌ لم أتمكن من جلب الاقتباس.",
          });
        }
        return;
      }

      // ميزة تحويل الملصق إلى صورة
      if (msg.message.stickerMessage && text.includes(".صورة")) {
        try {
          // إضافة رياكشن انتظار على رسالة المستخدم
          await sock.sendMessage(
            chatId, 
            { react: { key: msg.key, text: "⏳" }}
          );

          // استيراد دالة لتنزيل الرسائل
          const { downloadMediaMessage } = require("@whiskeysockets/baileys");

          const buffer = await downloadMediaMessage(
            msg,
            'buffer',
            {},
            { 
              logger: console,
              reuploadRequest: sock.updateMediaMessage
            }
          );

          // تأكد من وجود مجلد temp
          if (!fs.existsSync("./temp")) {
            fs.mkdirSync("./temp", { recursive: true });
          }

          const imagePath = `./temp/sticker_to_img_${Date.now()}.png`;

          await sharp(buffer)
            .resize(512, 512) // ضمان حجم مناسب
            .toFormat('png')
            .toFile(imagePath);

          // تغيير الرياكشن إلى علامة تمام
          await sock.sendMessage(
            chatId, 
            { react: { key: msg.key, text: "✅" }}
          );

          await sock.sendMessage(chatId, {
            image: { url: imagePath },
            caption: "🖼️ تم تحويل الملصق إلى صورة بنجاح"
          });

          // حذف الملف بعد الإرسال
          setTimeout(() => {
            try {
              if (fs.existsSync(imagePath)) {
                fs.unlinkSync(imagePath);
                console.log(`🗑️ تم حذف الملف المؤقت: ${imagePath}`);
              }
            } catch (err) {
              console.error(`⚠️ خطأ في حذف الملف المؤقت: ${err.message}`);
            }
          }, 3000);
        } catch (error) {
          console.error("❌ خطأ في تحويل الملصق إلى صورة:", error);
          
          // تغيير الرياكشن إلى علامة خطأ
          await sock.sendMessage(
            chatId, 
            { react: { key: msg.key, text: "❌" }}
          );
          
          await sock.sendMessage(chatId, {
            text: "❌ حدث خطأ أثناء تحويل الملصق إلى صورة. حاول مرة أخرى."
          });
        }
        return;
      }

      // أوامر التحميل
      if (command.startsWith(".فيس")) {
        try {
          const url = command.replace(".فيس ", "").trim();
          if (!url) {
            await sock.sendMessage(chatId, {
              text: "⚠️ استخدم الأمر هكذا: .فيس [رابط الفيديو]",
            });
            return;
          }
          await downloadAndSendVideo(sock, chatId, url, "facebook");
        } catch (error) {
          console.error("❌ خطأ في تحميل فيديو الفيسبوك:", error);
          await sock.sendMessage(chatId, {
            text: "❌ حدث خطأ في تحميل الفيديو",
          });
        }
        return;
      }

      if (command.startsWith(".يوتيوب")) {
        try {
          const url = command.replace(".يوتيوب ", "").trim();
          if (!url) {
            await sock.sendMessage(chatId, {
              text: "⚠️ استخدم الأمر هكذا: .يوتيوب [رابط الفيديو]",
            });
            return;
          }
          await downloadAndSendVideo(sock, chatId, url, "youtube");
        } catch (error) {
          console.error("❌ خطأ في تحميل فيديو اليوتيوب:", error);
          await sock.sendMessage(chatId, {
            text: "❌ حدث خطأ في تحميل الفيديو",
          });
        }
        return;
      }

      if (command.startsWith(".انستا")) {
        try {
          const url = command.replace(".انستا ", "").trim();
          if (!url) {
            await sock.sendMessage(chatId, {
              text: "⚠️ استخدم الأمر هكذا: .انستا [رابط الفيديو]",
            });
            return;
          }
          await downloadAndSendVideo(sock, chatId, url, "instagram");
        } catch (error) {
          console.error("❌ خطأ في تحميل فيديو الانستغرام:", error);
          await sock.sendMessage(chatId, {
            text: "❌ حدث خطأ في تحميل الفيديو",
          });
        }
        return;
      }

      // أمر الزخرفة للنصوص العربية والإنجليزية
      if (command.startsWith(".زخرفه ")) {
        try {
          const text = command.replace(".زخرفه ", "").trim();
          if (!text) {
            await sock.sendMessage(chatId, {
              text: "⚠️ استخدم: .زخرفه [النص المراد زخرفته]",
            });
            return;
          }

          // إضافة رياكشن انتظار
          await sock.sendMessage(
            chatId, 
            { react: { key: msg.key, text: "⏳" }}
          );

          const decoratedTexts = [];
          
          // زخارف عربية
          if (/[\u0600-\u06FF]/.test(text)) { // التحقق من وجود حروف عربية
            decoratedTexts.push(
              `🌟 ${text.split('').join(' ')}`,
              `✨ ${text.split('').reverse().join(' ')}`,
              `⭐️ ${text.split('').join('⭐️')}`,
              `〖 ${text} 〗`,
              `✧${text}✧`,
              `◄${text}►`,
              `.⋆｡⋆☂˚${text}｡⋆｡˚☽˚｡⋆`,
              `๑${text}๑`,
              `⌯ ${text} ⌯`,
              `ᯓ ${text} ᯓ`,
              `≪ ${text} ≫`,
              `⊶ ${text} ⊷`,
              `❨ ${text} ❩`,
              `๛${text}๛`,
              `⌘ ${text} ⌘`,
              `⊹${text}⊹`,
              `⚡️${text}⚡️`,
              `✿${text}✿`,
              `⚜️${text}⚜️`,
              `❀${text}❀`
            );
          } else { // زخارف إنجليزية
            const fancy = {
              a: ['𝒂', '𝓪', '𝔞', '𝕒', 'ᵃ'],
              b: ['𝒃', '𝓫', '𝔟', '𝕓', 'ᵇ'],
              c: ['𝒄', '𝓬', '𝔠', '𝕔', 'ᶜ'],
              // ... وهكذا لباقي الحروف
            };

            // تحويل النص لأشكال مختلفة
            let fancyText1 = text.toLowerCase().split('').map(c => 
              fancy[c] ? fancy[c][0] : c).join('');
            let fancyText2 = text.toLowerCase().split('').map(c => 
              fancy[c] ? fancy[c][1] : c).join('');

            decoratedTexts.push(
              `✧ ${text.toUpperCase()} ✧`,
              `✰ ${text.toLowerCase()} ✰`,
              fancyText1,
              fancyText2,
              `⟦ ${text} ⟧`,
              `【 ${text} 】`,
              `『 ${text} 』`,
              `☆ ${text} ☆`,
              `✵ ${text} ✵`,
              `⚔️ ${text} ⚔️`
            );
          }

          // تجميع النتائج في رسالة واحدة
          const result = `
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃     ✨ *أشكال الزخرفة* ✨     ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

${decoratedTexts.join('\n\n')}

💡 *اختر النمط الذي يعجبك ونسخه*
`;

          // تغيير الرياكشن إلى علامة تمام
          await sock.sendMessage(
            chatId, 
            { react: { key: msg.key, text: "✅" }}
          );

          await sock.sendMessage(chatId, { text: result });

        } catch (error) {
          console.error("❌ خطأ في الزخرفة:", error);
          // تغيير الرياكشن إلى علامة خطأ
          await sock.sendMessage(
            chatId, 
            { react: { key: msg.key, text: "❌" }}
          );
          await sock.sendMessage(chatId, {
            text: "❌ حدث خطأ أثناء زخرفة النص. حاول مرة أخرى."
          });
        }
        return;
      }
    };

    console.log("✅ البوت يعمل! امسح كود QR من واتساب ويب.");
  } catch (error) {
    console.error("❌ حدث خطأ:", error);
  }
}

// تحسين وظائف إرسال القوائم مع إضافة تأخير بين الإرسال
// وظيفة عامة لإرسال الرسائل مع التأخير وإعادة المحاولة
async function sendMessageWithRetry(sock, chatId, text, description, maxRetries = 3) {
  let retries = 0;
  const sendWithDelay = async () => {
    try {
      await sock.sendMessage(chatId, { text });
      console.log(`✅ تم إرسال ${description} بنجاح.`);
      return true;
    } catch (err) {
      retries++;
      console.error(`❌ محاولة ${retries}/${maxRetries} - فشل إرسال ${description}:`, err.message);

      if (retries < maxRetries) {
        console.log(`🔄 إعادة المحاولة بعد ${retries * 1000}ms...`);
        // تأخير متزايد بين المحاولات
        await new Promise(resolve => setTimeout(resolve, retries * 1000));
        return await sendWithDelay();
      }
      return false;
    }
  };

  return await sendWithDelay();
}

// قائمة الأوامر الرئيسية (فئات فقط)
async function sendCommandList(sock, chatId) {
  // إضافة رياكشن انتظار
  try {
    const messages = await sock.fetchMessages(chatId, 10);
    const lastMessage = messages.find(msg => 
      msg.message && 
      msg.message.conversation && 
      msg.message.conversation.includes(".اوامر"));
    
    if (lastMessage) {
      await sock.sendMessage(
        chatId, 
        { react: { key: lastMessage.key, text: "⏳" }}
      );
    }
  } catch (error) {
    console.error("خطأ في إضافة رياكشن الانتظار:", error);
  }

  const mainCommandList = `
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃       🌟 *فئات الأوامر المتاحة* 🌟        ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

🟢 *اختر فئة لعرض الأوامر المتاحة:*

   ⚙️ *.اوامر_عامة* - الأوامر العامة والأساسية

   📱 *.اوامر_تنزيل* - أوامر تحميل الفيديوهات

   👑 *.اوامر_ادمن* - أوامر المشرفين

   💬 *.اوامر_حوار* - الردود التلقائية

   🎬 *.اوامر_وسائط* - أوامر الوسائط المتعددة

   🎮 *.اوامر_العاب* - الألعاب والترفيه

💡 *اكتب أحد الأوامر أعلاه لعرض القائمة التفصيلية*
`;

  const result = await sendMessageWithRetry(sock, chatId, mainCommandList, "قائمة فئات الأوامر الرئيسية");
  
  // تغيير الرياكشن إلى علامة تمام
  try {
    const messages = await sock.fetchMessages(chatId, 10);
    const lastMessage = messages.find(msg => 
      msg.message && 
      msg.message.conversation && 
      msg.message.conversation.includes(".اوامر"));
    
    if (lastMessage) {
      await sock.sendMessage(
        chatId, 
        { react: { key: lastMessage.key, text: "✅" }}
      );
    }
  } catch (error) {
    console.error("خطأ في تغيير الرياكشن:", error);
  }
  
  return result;
}

// قائمة أوامر التنزيل
async function sendDownloadCommands(sock, chatId) {
  const downloadCommandList = `
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃       📥 *أوامر تنزيل الوسائط* 📥        ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

📱 *تنزيل من وسائل التواصل الاجتماعي*

   🔵 *فيسبوك*
   └─ *.فيس [رابط الفيديو]*
      مثال: .فيس https://www.facebook.com/watch?v=...

   🔴 *يوتيوب*
   └─ *.يوتيوب [رابط الفيديو]*
      مثال: .يوتيوب https://youtu.be/...

   🟣 *انستجرام*
   └─ *.انستا [رابط الفيديو]*
      مثال: .انستا https://www.instagram.com/p/...

💡 *ملاحظات*
   • قد يستغرق التنزيل وقتًا حسب حجم الفيديو
   • في حالة فشل التنزيل، جرب مرة أخرى أو تأكد من صحة الرابط

🔙 *للعودة إلى القائمة الرئيسية، اكتب* .اوامر
`;

  return await sendMessageWithRetry(sock, chatId, downloadCommandList, "قائمة أوامر التنزيل");
}

// قائمة أوامر المشرفين
async function sendAdminCommands(sock, chatId) {
  const adminCommandList = `
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃        👑 *أوامر المشرفين* 👑          ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

🛠️ *إدارة الأعضاء*
   ├─ *.ضيف [رقم الهاتف]* - إضافة عضو للمجموعة
   │   مثال: .ضيف 201234567890
   │
   └─ *.طرد [رقم الهاتف]* - طرد عضو من المجموعة
       مثال: .طرد 201234567890

📢 *التواصل*
   └─ *.منشن* - منشن لجميع أعضاء المجموعة

📊 *الإحصائيات*
   ├─ *.المجموعة* - عرض معلومات المجموعة
   └─ *.المتفاعلين* - عرض قائمة الأعضاء الأكثر تفاعلاً

⚠️ *ملاحظات هامة*
   • هذه الأوامر متاحة فقط للمشرفين
   • يجب أن يكون البوت مشرفًا لتنفيذ بعض هذه الأوامر

🔙 *للعودة إلى القائمة الرئيسية، اكتب* .اوامر
`;

  return await sendMessageWithRetry(sock, chatId, adminCommandList, "قائمة أوامر المشرفين");
}

// قائمة أوامر الردود التلقائية
async function sendChatCommands(sock, chatId) {
  const chatCommandList = `
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃       💬 *الردود التلقائية* 💬          ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

🤖 *البوت يرد تلقائيًا على هذه الكلمات:*

   • *اهلا* - 👋 أهلاً وسهلاً!

   • *مين* - 👋 انا بوت ذكاء اصطناعي لمساعده صاحب الرقم

   • *مرحبا* - 😊 مرحبًا! كيف يمكنني مساعدتك؟

   • *كيف حالك* - أنا بخير، شكرًا لسؤالك! 😊 وأنت؟

   • *من انتم* - نحن فريق one Team هنا لدعمك في اي وقت

   • *one team* - نحن شركه او مؤسسه لدعم المتعلمين او الخريجين

   • *خاص* - سيتم التواصل معك في اقرب وقت الرجاء الأنتظار

💡 *ملاحظة:* يمكنك استخدام هذه الكلمات في أي وقت للتفاعل مع البوت

🔙 *للعودة إلى القائمة الرئيسية، اكتب* .اوامر
`;

  return await sendMessageWithRetry(sock, chatId, chatCommandList, "قائمة الردود التلقائية");
}

// قائمة أوامر الوسائط المتعددة
async function sendMediaCommands(sock, chatId) {
  const mediaCommandList = `
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃       🎬 *أوامر الوسائط المتعددة* 🎬      ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

🖼️ *الصور والملصقات*

   • *التحويل إلى ملصق*
   └─ أرسل صورة مع تعليق *.ملصق*
      لتحويل الصورة إلى ملصق

   • *التحويل من ملصق إلى صورة*
   └─ أعد توجيه ملصق مع إضافة كلمة *.صورة*
      لتحويل الملصق إلى صورة

   • *البحث عن صور*
   └─ *.صورة [كلمة البحث]*
      مثال: .صورة طبيعة

🔊 *الصوتيات*
   └─ *.صوت [نص]*
      مثال: .صوت مرحبا بكم في المجموعة

💡 *ملاحظات مفيدة*
   • يمكنك استخدام هذه الأوامر في المجموعات أو الدردشات الخاصة
   • للحصول على أفضل النتائج، استخدم صورًا واضحة للتحويل إلى ملصقات

🔙 *للعودة إلى القائمة الرئيسية، اكتب* .اوامر
`;

  return await sendMessageWithRetry(sock, chatId, mediaCommandList, "قائمة أوامر الوسائط المتعددة");
}

// قائمة الأوامر العامة
async function sendGeneralCommands(sock, chatId) {
  const generalCommandList = `
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃         ⚙️ *الأوامر العامة* ⚙️          ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

🕒 *الوقت والمعلومات*
   └─ *.وقت* - معرفة الوقت الحالي

📊 *إحصائيات ومعلومات*
   ├─ *.رسائلي* - عرض عدد رسائلك
   ├─ *.المجموعة* - معلومات المجموعة الحالية
   └─ *.المتفاعلين* - أكثر الأعضاء تفاعلاً

🤖 *استعلامات ومعلومات*
   └─ *.بوت [سؤالك]* - اسأل البوت أي سؤال
       مثال: .بوت ما هي مصر؟

🔍 *أدوات مفيدة*
   ├─ *.حكمه* - إرسال حكمة عشوائية
   ├─ *.الصلاة* - مواقيت الصلاة
   └─ *.اقتباس* - اقتباس عشوائي

🔊 *الأوامر النصية*
   ├─ *.كرر [عدد] [نص]* - تكرار رسائل منفصلة
   │   مثال: .كرر 3 مرحباً
   │
   └─ *.كرر_سطر [عدد] [نص]* - تكرار في رسالة واحدة
       مثال: .كرر_سطر 5 مرحباً

🔙 *للعودة إلى القائمة الرئيسية، اكتب* .اوامر
`;

  return await sendMessageWithRetry(sock, chatId, generalCommandList, "قائمة الأوامر العامة");
}

// قائمة أوامر الألعاب
async function sendGamesCommands(sock, chatId) {
  const gamesCommandList = `
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃         🎮 *أوامر الألعاب* 🎮          ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

🎲 *الألعاب المتاحة*

   🎯 *لعبة إكس أو (XO)*
   ├─ *.xo* - عرض قائمة خيارات اللعب
   ├─ *.xo @[اسم_الشخص]* - بدء لعبة مع شخص محدد
   ├─ *.xo عام* - بدء لعبة مفتوحة للجميع
   ├─ *.xo [رقم]* - وضع علامة في المربع المحدد
   │   مثال: .xo 4
   │
   └─ *.الغاء* - إلغاء اللعبة الحالية

🧠 *أسئلة وثقافة*
   ├─ *.سؤال* - طرح سؤال ثقافي للمشاركين
   ├─ *.الغاء_سؤال* - إلغاء السؤال الحالي
   │
   └─ *.ثقافة* - عرض معلومات عن دول مختلفة
       (اختر رقم الدولة بعد ظهور القائمة)

💡 *ملاحظة:* للإجابة على الأسئلة، اكتب رقم الإجابة مع منشن للبوت
      مثال: @بوت 2

🔙 *للعودة إلى القائمة الرئيسية، اكتب* .اوامر
`;

  return await sendMessageWithRetry(sock, chatId, gamesCommandList, "قائمة أوامر الألعاب");
}

// دوال مساعدة لـ XO
function printBoard(board) {
  // استبدال X وO بالإيموجي
  const emojiBoard = [...board];
  for (let i = 0; i < emojiBoard.length; i++) {
    if (emojiBoard[i] === "X") emojiBoard[i] = "❌";
    else if (emojiBoard[i] === "O") emojiBoard[i] = "⭕";
    else emojiBoard[i] = `${emojiBoard[i]}️⃣`; // تحويل الأرقام إلى إيموجي أرقام
  }

  return `
┏━━━━━━┳━━━━━━┳━━━━━━┓
┃   ${emojiBoard[0]}   ┃   ${emojiBoard[1]}   ┃   ${emojiBoard[2]}   ┃
┣━━━━━━╋━━━━━━╋━━━━━━┫
┃   ${emojiBoard[3]}   ┃   ${emojiBoard[4]}   ┃   ${emojiBoard[5]}   ┃
┣━━━━━━╋━━━━━━╋━━━━━━┫
┃   ${emojiBoard[6]}   ┃   ${emojiBoard[7]}   ┃   ${emojiBoard[8]}   ┃
┗━━━━━━┻━━━━━━┻━━━━━━┛
  `;
}

function checkWin(board) {
  const winConditions = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
  ];

  for (let [a, b, c] of winConditions) {
    if (board[a] === board[b] && board[a] === board[c]) {
      return board[a];
    }
  }
  return null;
}

// دالة تنزيل الرسائل الوسائطية (مطلوبة لتحويل الملصقات والصور)
const downloadMediaMessage = async (message, type, options, options2) => {
  try {
    const stream = await require("@whiskeysockets/baileys").downloadContentFromMessage(
      message.message.stickerMessage || 
      message.message.imageMessage ||
      message.message.videoMessage ||
      message.message.audioMessage ||
      message.message.documentMessage,
      type,
      options
    );

    let buffer = Buffer.from([]);
    for await (const chunk of stream) {
      buffer = Buffer.concat([buffer, chunk]);
    }
    return buffer;
  } catch (error) {
    console.error("Error downloading media:", error);
    throw error;
  }
};

// دالة لتنزيل وإرسال فيديو
async function downloadAndSendVideo(sock, chatId, url, platform) {
  try {
    // إرسال رسالة جارٍ التحميل
    await sock.sendMessage(chatId, {
      text: `⏳ جاري تحميل الفيديو من ${platform}... يرجى الانتظار.`
    });

    const { default: fetch } = await import("node-fetch");
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`خطأ في جلب الفيديو من ${platform}: ${response.status}`);
    }

    const videoStream = response.body;
    const fileName = `video_${Date.now()}.mp4`;
    const filePath = `./temp/${fileName}`;

    // تأكد من وجود مجلد temp
    if (!fs.existsSync("./temp")) {
      fs.mkdirSync("./temp", { recursive: true });
    }

    await pipeline(videoStream, fs.createWriteStream(filePath));
    const videoData = fs.readFileSync(filePath);

    await sock.sendMessage(chatId, {
      video: videoData,
      mimetype: "video/mp4",
      caption: `📥 تم تنزيل الفيديو من ${platform} بنجاح!`,
      fileName: fileName,
    });

    // حذف الملف بعد الإرسال
    fs.unlinkSync(filePath);
    console.log(`✅ تم إرسال فيديو من ${platform} بنجاح`);
  } catch (error) {
    console.error(`❌ خطأ في تحميل فيديو ${platform}:`, error);
    await sock.sendMessage(chatId, {
      text: `❌ حدث خطأ في تحميل الفيديو من ${platform}. تأكد من صحة الرابط وحاول مرة أخرى.`
    });
  }
}

// إنشاء خادم HTTP بسيط للحفاظ على uptime
const app = express();
const PORT = process.env.PORT || 3001;

// إضافة الصفحة الرئيسية للبوت
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, 'botwebpage.html'));
});

app.get("/ping", (req, res) => {
  res.send("pong");
});

app.get("/uptime", (req, res) => {
  res.send({ 
    status: "online", 
    timestamp: new Date().toISOString(),
    botInfo: {
      name: "بوت الواتساب الذكي",
      version: "1.2.0",
      features: ["تحميل فيديوهات", "تحويل النص إلى صوت", "إنشاء ملصقات", "ألعاب", "إدارة المجموعات"]
    }
  });
});

// إضافة مسار لحالة البوت بالتفصيل
app.get("/status", (req, res) => {
  const botStatus = {
    running: true,
    startTime: new Date(),
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    platform: process.platform,
    nodeVersion: process.version
  };

  res.json(botStatus);
});

// تحسين معالجة الأخطاء عند فتح المنفذ
// تحسين إعدادات الخادم للحفاظ على الاتصال
const server = app
  .listen(PORT, "0.0.0.0", () => {
    console.log(`🌐 خادم HTTP يعمل على المنفذ ${PORT}`);
    
    // إضافة فحص دوري للحفاظ على النشاط
    setInterval(() => {
      try {
        const options = {
          host: "0.0.0.0",
          port: PORT,
          path: "/ping"
        };
        
        require("http").get(options, (res) => {
          if (res.statusCode === 200) {
            console.log("✅ فحص النشاط: متصل");
          }
        }).on("error", (err) => {
          console.log("⚠️ فحص النشاط: منقطع -", err.message);
          // محاولة إعادة تشغيل الخادم
          startBot();
        });
      } catch (error) {
        console.error("❌ خطأ في فحص النشاط:", error);
      }
    }, 25000); // فحص كل 25 ثانية
  })
  .on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(
        `❌ المنفذ ${PORT} مشغول بالفعل. سأحاول استخدام منفذ آخر...`,
      );
      // البحث عن منفذ متاح تلقائياً
      const tryPort = (port) => {
        const server = app
          .listen(port, "0.0.0.0", () => {
            console.log(`🌐 خادم HTTP يعمل على المنفذ ${port}`);
          })
          .on("error", (error) => {
            if (error.code === "EADDRINUSE") {
              console.error(
                `❌ المنفذ ${port} مشغول أيضًا. جاري المحاولة على منفذ آخر...`,
              );
              tryPort(port + 1);
            } else {
              console.error("❌ خطأ في تشغيل الخادم:", error);
            }
          });
      };
      tryPort(PORT + 1);
    } else {
      console.error("❌ خطأ في تشغيل الخادم:", error);
    }
  });

// إضافة معالج لإيقاف الخادم عند الخروج
process.on("SIGINT", () => {
  console.log("🛑 تم إيقاف البوت...");
  if (server) server.close();  process.exit(0);
});

// نظام المراقبة الذاتية المحسّن والمطور للحفاظ على البوت نشطاً
function keepAlive() {
  // الحصول على عنوان URL من متغيرات البيئة أو استخدام العنوان المحلي
  const serverUrl =
    process.env.REPLIT_URL ||
    `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co` ||
    `http://0.0.0.0:${PORT}`;

  console.log(`🌐 عنوان المراقبة: ${serverUrl}`);

  let lastSuccessfulCheck = Date.now();
  let botStatus = {
    running: true,
    lastRestart: Date.now(),
    pingCount: 0,
    failCount: 0,
  };

  // إنشاء ملف لإظهار حالة البوت
  fs.writeFileSync(
    "bot_status.txt",
    "قيد التشغيل" + new Date().toLocaleString("ar-EG"),
  );

  // تنظيف الذاكرة دورياً
  setInterval(
    () => {
      try {
        if (typeof global.gc === "function") {
          global.gc(); // تنظيف الذاكرة
          console.log("🧹 تم تنظيف الذاكرة");
        }

        // تحديث ملف الحالة
        fs.writeFileSync(
          "bot_status.txt",
          `قيد التشغيل - آخر تحديث: ${new Date().toLocaleDateString("ar-EG")}`,
        );
      } catch (e) {
        // تجاهل الخطأ إذا كانت الميزة غير متاحة
      }
    },
    5 * 60 * 1000,
  ); // كل 5 دقائق

  // نظام التشغيل المستمر - فحص أكثر تكراراً
  const checkInterval = setInterval(() => {
    try {
      // زيادة عداد محاولات الاتصال
      botStatus.pingCount++;

      // استخدام timeout أقصر للكشف السريع عن المشاكل
      axios
        .get(`${serverUrl}/uptime`, { timeout: 5000 })
        .then((response) => {
          const timestamp = new Date().toLocaleTimeString("ar-EG");
          lastSuccessfulCheck = Date.now();
          botStatus.failCount = 0; // إعادة تعيين عداد الفشل

          // طباعة حالة كل 10 نبضات فقط لتجنب ملء السجل
          if (botStatus.pingCount % 10 === 0) {
            console.log(
              `✅ [${timestamp}] نبض المراقبة #${botStatus.pingCount}: نشط (وقت التشغيل: ${formatUptime(botStatus.lastRestart)})`,
            );
          }
        })
        .catch((error) => {
          botStatus.failCount++;
          console.error(
            `❌ خطأ في المراقبة الذاتية (${botStatus.failCount}/3):`,
            error.message,
          );

          // إعادة تشغيل البوت بعد 3 محاولات فاشلة متتالية
          if (botStatus.failCount >= 3 && !isRestarting) {
            console.log("⚠️ فشل في 3 محاولات متتالية - إعادة تشغيل البوت...");
            isRestarting = true;
            botStatus.lastRestart = Date.now();

            // محاولة إنهاء أي اتصالات سابقة
            try {
              if (server) server.close();
            } catch (e) {
              console.log("ℹ️ لا يوجد خادم HTTP لإغلاقه");
            }

            // إعادة تشغيل البوت بعد فترة قصيرة
            setTimeout(() => {
              startBot();
              isRestarting = false;
              botStatus.failCount = 0;
            }, 5000);
          }
        });

      // التحقق من الاتصال المستمر - إذا مر وقت طويل دون نجاح (10 دقائق)
      const inactiveTime = Date.now() - lastSuccessfulCheck;
      if (inactiveTime > 10 * 60 * 1000 && !isRestarting) {
        // 10 دقائق
        console.log(
          `⚠️ لم يتم تسجيل نشاط ناجح لمدة ${Math.floor(inactiveTime / 60000)} دقائق - إعادة تشغيل إجبارية...`,
        );
        isRestarting = true;
        botStatus.lastRestart = Date.now();

        // محاولة إغلاق الاتصالات والبدء من جديد
        try {
          if (server) server.close();
        } catch (e) {}

        setTimeout(() => {
          startBot();
          isRestarting = false;
          botStatus.failCount = 0;
        }, 5000);
      }
    } catch (error) {
      console.error("❌ خطأ غير متوقع في المراقبة الذاتية:", error);
    }
  }, 60 * 1000); // فحص كل دقيقة

  // فحص إضافي سريع كل 15 ثانية للاستجابة السريعة للمشاكل
  const quickCheckInterval = setInterval(() => {
    try {
      axios.get(`${serverUrl}/ping`, { timeout: 3000 }).catch((error) => {
        console.log("⚠️ فشل الفحص السريع - قد يكون هناك مشكلة في الاتصال");
        botStatus.failCount++;
      });
    } catch (error) {
      // تجاهل أخطاء الفحص السريع
    }
  }, 15 * 1000);

  // دالة مساعدة لتنسيق وقت التشغيل
  function formatUptime(startTime) {
    const uptime = Date.now() - startTime;
    const hours = Math.floor(uptime / (1000 * 60 * 60));
    const minutes = Math.floor((uptime % (1000 * 60 * 60)) / (1000 * 60));
    return `${hours}h ${minutes}m`;
  }

  // إضافة معالج للنظام يمنع البرنامج من التوقف بسبب أخطاء غير معالجة
  process.on("uncaughtException", (err) => {
    console.error("🔴 خطأ غير معالج:", err);
    // عدم إنهاء البرنامج، فقط تسجيل الخطأ
  });

  process.on("unhandledRejection", (reason, promise) => {
    console.error("🔴 رفض وعد غير معالج:", reason);
    // عدم إنهاء البرنامج، فقط تسجيل الخطأ
  });

  console.log("⏱️ تم تفعيل نظام المراقبة الذاتية المحسّن والمطور");
}

// تنظيف الملفات المؤقتة دوريًا بشكل محسّن
function cleanupTempFiles() {
  console.log("🧹 جاري تنظيف الملفات المؤقتة...");

  // استخدام نهج متزامن للتأكد من اكتمال عملية التنظيف
  try {
    // تنظيف كل المجلدات المؤقتة
    const dirsToClean = ['temp', 'audio', 'stickers'];

    dirsToClean.forEach(dir => {
      if (fs.existsSync(`./${dir}`)) {
        const files = fs.readdirSync(`./${dir}`);

        if (files.length === 0) {
          console.log(`✓ مجلد ${dir} فارغ بالفعل`);
        } else {
          console.log(`🔍 تم العثور على ${files.length} ملف في مجلد ${dir} للتنظيف`);

          let deletedCount = 0;
          let failedCount = 0;

          // حذف الملفات المؤقتة
          for (const file of files) {
            const filePath = `./${dir}/${file}`;
            try {
              // التحقق من عمر الملف (أكثر من 15 دقيقة) لتجنب حذف الملفات قيد الاستخدام
              const stats = fs.statSync(filePath);
              const fileAge = Date.now() - stats.mtimeMs;

              if (fileAge > 15 * 60 * 1000) {
                // أكثر من 15 دقيقة
                fs.unlinkSync(filePath);
                deletedCount++;
              }
            } catch (err) {
              failedCount++;
              console.error(`⚠️ فشل حذف الملف المؤقت ${filePath}:`, err.message);
            }
          }

          console.log(`✅ اكتمل تنظيف ${dir}: تم حذف ${deletedCount} ملف، فشل حذف ${failedCount} ملف`);
        }
      } else {
        console.log(`✓ مجلد ${dir} غير موجود، سيتم إنشاؤه عند الحاجة`);
      }
    });

    // التحقق من استخدام الذاكرة
    const memoryUsage = process.memoryUsage();
    console.log(
      `📊 استخدام الذاكرة: ${Math.round(memoryUsage.rss / 1024 / 1024)}MB RSS, ${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB Heap`,
    );
  } catch (error) {
    console.error("❌ خطأ أثناء تنظيف الملفات المؤقتة:", error);
  }

  // جدولة التنظيف التالي (كل 30 دقيقة)
  setTimeout(cleanupTempFiles, 30 * 60 * 1000);
}

// وظيفة طوارئ للتنظيف عند ارتفاع استخدام الذاكرة
function monitorMemoryUsage() {
  setInterval(
    () => {
      const memoryUsage = process.memoryUsage();
      const usedMemoryMB = Math.round(memoryUsage.rss / 1024 / 1024);

      // إذا تجاوز استخدام الذاكرة 500 ميجابايت، قم بتنظيف فوري
      if (usedMemoryMB > 500) {
        console.log(
          `⚠️ استخدام ذاكرة مرتفع (${usedMemoryMB}MB)، بدء تنظيف طارئ...`,
        );
        cleanupTempFiles();
      }
    },
    5 * 60 * 1000,
  ); // فحص كل 5 دقائق
}

// إعداد عمليات المراقبة والتنظيف الدورية
console.log("🚀 بدء تشغيل البوت الذكي للواتساب...");

startBot();
keepAlive(); // تشغيل نظام المراقبة الذاتية
cleanupTempFiles(); // بدء تنظيف الملفات المؤقتة
monitorMemoryUsage(); // بدء مراقبة استخدام الذاكرة

// إعداد عملية إعادة تشغيل دورية كل 12 ساعة للحفاظ على استقرار البوت
setInterval(
  () => {
    console.log("⏰ إعادة تشغيل مجدولة للحفاظ على الاستقرار...");
    if (!isRestarting) {
      isRestarting = true;
      setTimeout(() => {
        startBot();
      }, 5000);
    }
  },
  12 * 60 * 60 * 1000,
)}; // كل 12 ساعة